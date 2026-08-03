import { executeGoalCommand, type GoalCommandResult } from './goalCommandService.js';
import { GoalService } from './goalService.js';
import { GOAL_METADATA_KEY } from './goalStore.js';
import {
  ProjectGoalStore,
  type ProjectGoalEvent,
  type ProjectGoalSummary,
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

  constructor(projectStateDirectory: string) {
    this.storePromise = ProjectGoalStore.open(projectStateDirectory).then(store => {
      this.resolvedStore = store;
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
    const forceNew = command === 'start'
      || (Boolean(command) && !GOAL_COMMANDS.has(command));
    return executeGoalCommand(
      await this.serviceForSession(session, { forceNew }),
      rawArgs,
    );
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

  async detach(sessionId: string): Promise<void> {
    (await this.store()).detachSession(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    (await this.storePromise).close();
  }

  private async store(): Promise<ProjectGoalStore> {
    if (this.closed) throw new Error('Project Goal API is closed.');
    return this.storePromise;
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
