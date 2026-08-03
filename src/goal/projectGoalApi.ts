import { executeGoalCommand, type GoalCommandResult } from './goalCommandService.js';
import { decideGoalExecution } from './goalController.js';
import {
  GoalContinuationService,
  type GoalContinuationExecutor,
  type GoalContinuationRunResult,
} from './goalContinuation.js';
import { GoalService } from './goalService.js';
import { GOAL_METADATA_KEY } from './goalStore.js';
import {
  ProjectGoalStore,
  type ProjectGoalEvent,
  type ProjectGoalSummary,
  type GoalContinuationMode,
  type GoalContinuationProfileRef,
  type GoalContinuationState,
} from './projectGoalStore.js';
import type { Goal, GoalBudget, GoalEvidence } from './types.js';

export interface GoalSessionIdentity {
  id: string;
  metadata: Record<string, unknown>;
  mergeMetadata?(metadata: Record<string, unknown>): Promise<unknown>;
}

export interface ProjectGoalStatus {
  goalId?: string;
  goal: Goal | null;
  evidence: GoalEvidence[];
  budget?: GoalBudget;
}

/** Shared SDK/UI facade over the canonical project Goal database. */
export class ProjectGoalApi {
  private readonly storePromise: Promise<ProjectGoalStore>;
  private resolvedStore?: ProjectGoalStore;
  private closed = false;
  private readonly continuationExecutor?: GoalContinuationExecutor;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    projectStateDirectory: string,
    options: { continuationExecutor?: GoalContinuationExecutor } = {},
  ) {
    this.continuationExecutor = options.continuationExecutor;
    this.storePromise = ProjectGoalStore.open(projectStateDirectory).then(store => {
      this.resolvedStore = store;
      if (this.continuationExecutor) {
        for (const state of store.listScheduledContinuations()) this.schedule(state);
      }
      return store;
    });
  }

  /** Synchronous UI cache read after the project database has been opened. */
  peek(sessionId?: string): Goal | null {
    if (!this.resolvedStore) return null;
    if (sessionId) return this.resolvedStore.readForSession(sessionId)?.goal ?? null;
    const goalId = this.resolvedStore.currentGoalId();
    return goalId ? this.resolvedStore.readSnapshot(goalId) : null;
  }

  async serviceForSession(
    session: GoalSessionIdentity,
    options: { forceNew?: boolean } = {},
  ): Promise<GoalService> {
    const store = await this.store();
    if (!options.forceNew && session.metadata[GOAL_METADATA_KEY] !== undefined) {
      const imported = store.importLegacyGoal(session.id, session.metadata[GOAL_METADATA_KEY]);
      if (imported && session.mergeMetadata) {
        await session.mergeMetadata({ [GOAL_METADATA_KEY]: undefined });
      }
    }
    return new GoalService({ port: store.portForSession(session.id, options) });
  }

  async command(session: GoalSessionIdentity, rawArgs: string): Promise<GoalCommandResult> {
    const command = rawArgs.trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
    if (command === 'schedule') return this.configureContinuationCommand(session, rawArgs);
    if (command === 'run' && this.continuationExecutor) {
      const status = await this.status(session.id);
      if (!status.goalId || !status.goal) {
        return { ok: false, changed: false, message: 'no goal set — use /goal start <objective>', goal: null };
      }
      const run = await this.runContinuation(session.id, { force: true });
      return {
        ok: run.started,
        changed: run.started,
        message: `goal continuation: ${run.turns} turn(s) · ${run.reason}`,
        goal: run.goal,
      };
    }
    const forceNew = command === 'start'
      || (Boolean(command) && !GOAL_COMMANDS.has(command));
    const result = await executeGoalCommand(
      await this.serviceForSession(session, { forceNew }),
      rawArgs,
    );
    if (command === 'status' || command === '') {
      const continuation = await this.continuationStatus(session.id);
      if (continuation) {
        return {
          ...result,
          message: `${result.message}\ncontinuation ${continuation.mode} · interval ${continuation.currentIntervalSeconds}s${continuation.nextWakeAt ? ` · next ${continuation.nextWakeAt}` : ''}${continuation.leaseOwner ? ` · leased by ${continuation.leaseOwner}` : ''}`,
        };
      }
    }
    return result;
  }

  async status(sessionId?: string): Promise<ProjectGoalStatus> {
    const store = await this.store();
    const record = sessionId
      ? store.readForSession(sessionId)
      : (() => {
          const goalId = store.currentGoalId();
          const goal = goalId ? store.readSnapshot(goalId) : null;
          return goalId && goal ? { id: goalId, goal } : undefined;
        })();
    return {
      ...(record ? { goalId: record.id } : {}),
      goal: record?.goal ?? null,
      evidence: record?.goal.evidence ?? [],
      ...(record?.goal.budget ? { budget: record.goal.budget } : {}),
    };
  }

  async list(options: { includeArchived?: boolean; limit?: number } = {}): Promise<ProjectGoalSummary[]> {
    return (await this.store()).listGoals(options);
  }

  async history(goalId: string, limit = 100): Promise<ProjectGoalEvent[]> {
    return (await this.store()).history(goalId, limit);
  }

  async attach(sessionId: string, goalId: string): Promise<void> {
    const store = await this.store();
    if (!store.readSnapshot(goalId)) throw new Error(`Unknown or archived Goal: ${goalId}`);
    store.attachSession(sessionId, goalId);
  }

  async continuationStatus(sessionId?: string): Promise<GoalContinuationState | undefined> {
    const status = await this.status(sessionId);
    return status.goalId ? (await this.store()).continuationState(status.goalId) : undefined;
  }

  async configureContinuation(input: {
    sessionId: string;
    mode: GoalContinuationMode;
    executionProfile?: GoalContinuationProfileRef;
    minIntervalSeconds?: number;
    maxIntervalSeconds?: number;
  }): Promise<GoalContinuationState> {
    const store = await this.store();
    const record = store.readForSession(input.sessionId);
    if (!record) throw new Error('No project Goal is attached to this session.');
    const state = store.configureContinuation({
      goalId: record.id,
      mode: input.mode,
      ...(input.executionProfile ? { executionProfile: input.executionProfile } : {}),
      ...(input.minIntervalSeconds !== undefined ? { minIntervalSeconds: input.minIntervalSeconds } : {}),
      ...(input.maxIntervalSeconds !== undefined ? { maxIntervalSeconds: input.maxIntervalSeconds } : {}),
    });
    this.clearTimer(record.id);
    if (state.mode === 'scheduled' && this.continuationExecutor) this.schedule(state);
    return state;
  }

  async runContinuation(
    sessionId: string,
    options: { force?: boolean; mode?: GoalContinuationMode; signal?: AbortSignal } = {},
  ): Promise<GoalContinuationRunResult> {
    if (!this.continuationExecutor) throw new Error('Goal continuation executor is unavailable.');
    const store = await this.store();
    const record = store.readForSession(sessionId);
    if (!record) {
      return { started: false, turns: 0, reason: 'No project Goal is attached.', goal: null };
    }
    let continuation = store.continuationState(record.id);
    if (!continuation) {
      continuation = store.configureContinuation({ goalId: record.id, mode: options.mode ?? 'manual' });
    }
    const result = await new GoalContinuationService(store, this.continuationExecutor).run({
      goalId: record.id,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.continuation?.mode === 'scheduled') this.schedule(result.continuation);
    return result;
  }

  async detach(sessionId: string): Promise<void> {
    (await this.store()).detachSession(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    (await this.storePromise).close();
  }

  private async store(): Promise<ProjectGoalStore> {
    if (this.closed) throw new Error('Project Goal API is closed.');
    return this.storePromise;
  }

  private async configureContinuationCommand(
    session: GoalSessionIdentity,
    rawArgs: string,
  ): Promise<GoalCommandResult> {
    const [, modeValue = '', minValue = '', maxValue = '', profileValue = ''] = rawArgs.trim().split(/\s+/u);
    if (!['manual', 'foreground', 'scheduled'].includes(modeValue)) {
      return {
        ok: false,
        changed: false,
        message: 'usage: /goal schedule <manual|foreground|scheduled> [min-seconds] [max-seconds] [config:name|agent:name]',
        goal: (await this.status(session.id)).goal,
      };
    }
    const separator = profileValue.indexOf(':');
    const profile = separator > 0
      && (profileValue.slice(0, separator) === 'config' || profileValue.slice(0, separator) === 'agent')
      ? {
          kind: profileValue.slice(0, separator) as GoalContinuationProfileRef['kind'],
          name: profileValue.slice(separator + 1),
        }
      : undefined;
    const state = await this.configureContinuation({
      sessionId: session.id,
      mode: modeValue as GoalContinuationMode,
      ...(Number(minValue) > 0 ? { minIntervalSeconds: Number(minValue) } : {}),
      ...(Number(maxValue) > 0 ? { maxIntervalSeconds: Number(maxValue) } : {}),
      ...(profile?.name ? { executionProfile: profile } : {}),
    });
    return {
      ok: true,
      changed: true,
      message: `goal continuation: ${state.mode} · ${state.currentIntervalSeconds}s${state.nextWakeAt ? ` · next ${state.nextWakeAt}` : ''}`,
      goal: (await this.status(session.id)).goal,
    };
  }

  private schedule(state: GoalContinuationState): void {
    this.clearTimer(state.goalId);
    if (this.closed || state.mode !== 'scheduled' || !state.sessionId || !state.nextWakeAt) return;
    const goal = this.resolvedStore?.readSnapshot(state.goalId);
    if (!goal || decideGoalExecution(goal).kind === 'stop') return;
    const delay = Math.max(0, Math.min(Date.parse(state.nextWakeAt) - Date.now(), 2_147_000_000));
    const timer = setTimeout(() => {
      this.timers.delete(state.goalId);
      void this.runContinuation(state.sessionId!, { mode: 'scheduled' }).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.timers.set(state.goalId, timer);
  }

  private clearTimer(goalId: string): void {
    const timer = this.timers.get(goalId);
    if (timer) clearTimeout(timer);
    this.timers.delete(goalId);
  }
}

const GOAL_COMMANDS = new Set([
  'status',
  'clear',
  'pause',
  'resume',
  'cancel',
  'tasks',
  'plan',
  'history',
  'replan',
  'answer',
  'run',
  'complete',
  'done',
]);
