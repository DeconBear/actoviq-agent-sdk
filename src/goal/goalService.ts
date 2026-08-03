/**
 * GoalService - the single authority over Goal lifecycle.
 *
 * Both the runtime (via controlled Goal tools) and UI surfaces (GUI/TUI/CLI)
 * call this service. The service enforces:
 *  - revision-based compare-and-swap on every mutation (catches concurrent edits);
 *  - that `complete`/`blocked` transitions carry evidence or a reason;
 *  - a three-repeat block audit: only the third consecutive report with the
 *    same reason transitions the Goal to blocked.
 *
 * The service never persists directly; it goes through a `GoalSessionPort`
 * so it is agnostic to whether it runs against a live AgentSession or a test
 * snapshot. All timestamps come from an injected clock so tests are deterministic.
 */
import {
  AgentSessionGoalPort,
  readGoal,
  updateGoal,
  type GoalSessionPort,
} from './goalStore.js';
import type {
  Goal,
  GoalBudget,
  GoalEvidence,
  GoalMutationResult,
  GoalStatus,
  GoalTurnReceipt,
  GoalWorkItem,
  GoalWorkItemClass,
  GoalWorkItemPriority,
  GoalWorkItemRole,
} from './types.js';
import { GOAL_SCHEMA_VERSION } from './types.js';

/** Clock function used so tests can be deterministic. */
export type GoalClock = () => string;

export interface GoalServiceOptions {
  port: GoalSessionPort;
  now?: GoalClock;
}

export interface CreateGoalInput {
  objective: string;
  completionCriteria?: string;
  budget?: GoalBudget;
}

export interface ProgressGoalInput {
  note: string;
  toolCalls?: number;
  tokens?: number;
  expectedRevision?: number;
}

export interface BlockGoalInput {
  reason: string;
  turn?: number;
  expectedRevision?: number;
}

export interface SettleGoalTurnInput {
  receipt: GoalTurnReceipt;
  evidence: GoalEvidence[];
  observedRefs?: string[];
  /** Compatibility override for trusted runtime callers; normal settlement derives this. */
  completionAccepted?: boolean;
  replan?: {
    trigger: string;
    frontierFingerprint: string;
    deltaRecorded: boolean;
  };
}

export interface PlanGoalItemInput {
  id?: string;
  role?: GoalWorkItemRole;
  priority?: GoalWorkItemPriority;
  taskClass?: GoalWorkItemClass;
  actionKind?: string;
  text: string;
  dependsOn?: string[];
  successorOf?: string;
  resumeWhen?: string;
}

export interface PlanGoalInput {
  items: PlanGoalItemInput[];
  replace?: boolean;
  reason?: string;
  expectedRevision?: number;
}

export interface RequestGoalWorkItemUpdateInput {
  workItemId: string;
  status: 'open' | 'done' | 'deferred' | 'cancelled';
  note: string;
  evidenceRefs?: string[];
  noFollowupReason?: string;
  resumeWhen?: string;
  expectedRevision?: number;
}

/** Result of a status transition used by /goal pause|resume|clear in the UI. */
export type GoalTransitionResult = GoalMutationResult;

const BLOCK_REPEAT_THRESHOLD = 3;

export class GoalService {
  private readonly port: GoalSessionPort;
  private readonly now: GoalClock;

  constructor(options: GoalServiceOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Build a GoalService over a live AgentSession-like object. */
  static forSession(session: {
    metadata: Record<string, unknown>;
    mergeMetadata(metadata: Record<string, unknown>): Promise<unknown>;
    mutateMetadata?(
      mutation: (metadata: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  }): GoalService {
    return new GoalService({ port: new AgentSessionGoalPort(session) });
  }

  /** Read the current goal, normalizing any legacy persisted shape. */
  async read(): Promise<Goal | null> {
    return readGoal(this.port, this.now());
  }

  /** Create a new goal, replacing any existing one. */
  async create(input: CreateGoalInput): Promise<Goal> {
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error('Goal objective must not be empty.');
    }
    const ts = this.now();
    const goal: Goal = {
      version: GOAL_SCHEMA_VERSION,
      objective,
      status: 'active',
      consumption: { turns: 0, toolIterations: 0, tokens: 0 },
      delivery: { validatedTurns: 0, completedWorkItems: 0, evidenceItems: 0 },
      evidence: [],
      blockAudit: [],
      turnReceipts: [],
      workItems: [createBootstrapWorkItem(objective, ts)],
      workItemRequests: [],
      planRevision: 0,
      replanAudit: [],
      createdAt: ts,
      updatedAt: ts,
      revision: 0,
      ...(input.completionCriteria?.trim() ? { completionCriteria: input.completionCriteria.trim() } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
    };
    return updateGoal(this.port, ts, () => ({ next: goal, result: goal }));
  }

  /** Clear (delete) the current goal. No-op if there is none. */
  async clear(): Promise<void> {
    await updateGoal(this.port, this.now(), () => ({ next: undefined, result: undefined }));
  }

  /**
   * Record progress evidence. Only valid while the goal is active.
   * The runtime calls this at the end of each turn.
   */
  async progress(input: ProgressGoalInput): Promise<GoalMutationResult> {
    const note = input.note.trim();
    if (!note) {
      return { ok: false, reason: 'invalid_transition', message: 'Progress note must not be empty.' };
    }
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, input.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No active goal to record progress for.' } as const,
        };
      }
      if (current.status !== 'active') {
        return {
          next: current,
          result: {
            ok: false,
            reason: 'invalid_transition',
            message: `Cannot record progress: goal is ${current.status}.`,
          } as const,
        };
      }
      const evidence: GoalEvidence = {
        at,
        note,
        ...(typeof input.toolCalls === 'number' ? { toolCalls: input.toolCalls } : {}),
        ...(typeof input.tokens === 'number' ? { tokens: input.tokens } : {}),
      };
      const next: Goal = {
        ...current,
        evidence: [...current.evidence, evidence].slice(-EVIDENCE_RETAIN),
        updatedAt: evidence.at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Replace or extend the ordered executable frontier with a validated plan. */
  async plan(input: PlanGoalInput): Promise<GoalMutationResult> {
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, input.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to plan.' } as const,
        };
      }
      if (current.status !== 'active') {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: `Cannot plan: goal is ${current.status}.` } as const,
        };
      }
      let planned: GoalWorkItem[];
      try {
        planned = normalizePlannedItems(input.items, at, input.replace === false ? current.workItems : []);
      } catch (error) {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: (error as Error).message } as const,
        };
      }
      const next: Goal = {
        ...current,
        workItems: planned,
        workItemRequests: [],
        planRevision: current.planRevision + 1,
        replanAudit: input.reason?.trim()
          ? [...current.replanAudit, {
              at,
              trigger: input.reason.trim(),
              frontierFingerprint: frontierFingerprint(current),
              repeat: 0,
              deltaRecorded: true,
            }].slice(-REPLAN_AUDIT_RETAIN)
          : current.replanAudit,
        forcedReplan: undefined,
        noFollowupReason: undefined,
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Mark the selected executable item as running before the model request. */
  async beginWorkItem(workItemId: string): Promise<GoalMutationResult> {
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      if (!current) {
        return { next: undefined, result: { ok: false, reason: 'not_found', message: 'No goal.' } as const };
      }
      const index = current.workItems.findIndex(item => item.id === workItemId);
      const item = current.workItems[index];
      if (!item || item.role !== 'agent' || !['open', 'claimed', 'running'].includes(item.status)) {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: `Goal work item ${workItemId} is not runnable.` } as const,
        };
      }
      if (item.status === 'running') return { next: current, result: { ok: true, goal: current } as const };
      const workItems = [...current.workItems];
      workItems[index] = { ...item, status: 'running', updatedAt: at };
      const next: Goal = {
        ...current,
        workItems,
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Force the next Goal turn into bounded replanning. */
  async forceReplan(reason = 'operator_requested'): Promise<GoalMutationResult> {
    const at = this.now();
    const normalized = reason.trim() || 'operator_requested';
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      if (!current) {
        return { next: undefined, result: { ok: false, reason: 'not_found', message: 'No goal.' } as const };
      }
      if (current.status !== 'active') {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: `Cannot replan: goal is ${current.status}.` } as const,
        };
      }
      const next: Goal = {
        ...current,
        forcedReplan: { at, reason: normalized },
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Queue a model-authored work-item transition for runtime settlement. */
  async requestWorkItemUpdate(input: RequestGoalWorkItemUpdateInput): Promise<GoalMutationResult> {
    const note = input.note.trim();
    if (!note) {
      return { ok: false, reason: 'invalid_transition', message: 'Work-item update note must not be empty.' };
    }
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, input.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to update.' } as const,
        };
      }
      if (!current.workItems.some(item => item.id === input.workItemId)) {
        return {
          next: current,
          result: { ok: false, reason: 'not_found', message: `Unknown Goal work item: ${input.workItemId}` } as const,
        };
      }
      const request = {
        at,
        workItemId: input.workItemId,
        status: input.status,
        note,
        evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
        ...(input.noFollowupReason?.trim() ? { noFollowupReason: input.noFollowupReason.trim() } : {}),
        ...(input.resumeWhen?.trim() ? { resumeWhen: input.resumeWhen.trim() } : {}),
      };
      const next: Goal = {
        ...current,
        workItemRequests: [
          ...current.workItemRequests.filter(item => item.workItemId !== input.workItemId),
          request,
        ],
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Resolve a user-owned gate with runtime-owned user evidence. */
  async answerUserGate(workItemId: string, answer: string): Promise<GoalMutationResult> {
    const note = answer.trim();
    if (!note) {
      return { ok: false, reason: 'invalid_transition', message: 'Gate answer must not be empty.' };
    }
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      if (!current) {
        return { next: undefined, result: { ok: false, reason: 'not_found', message: 'No goal.' } as const };
      }
      const index = current.workItems.findIndex(item => item.id === workItemId);
      const item = current.workItems[index];
      if (!item || item.role !== 'user' || item.taskClass !== 'user_gate') {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: 'The item is not a user gate.' } as const,
        };
      }
      const evidenceRef = `user:${workItemId}:${current.revision + 1}`;
      const userEvidence: GoalEvidence = {
        id: `goal-evidence:${evidenceRef}`,
        at,
        note,
        kind: 'user_decision',
        ref: evidenceRef,
        verified: true,
      };
      const workItems = [...current.workItems];
      workItems[index] = { ...item, status: 'done', evidenceRefs: [evidenceRef], updatedAt: at };
      const next: Goal = {
        ...current,
        status: 'active',
        workItems,
        planRevision: current.planRevision + 1,
        evidence: [...current.evidence, userEvidence].slice(-EVIDENCE_RETAIN),
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /**
   * Report a blocked turn. Runtime-only: requires a reason. The Goal stays
   * active for the first two reports and becomes blocked only when the same
   * reason recurs BLOCK_REPEAT_THRESHOLD times in a row.
   */
  async block(input: BlockGoalInput): Promise<GoalMutationResult> {
    const reason = input.reason.trim();
    if (!reason) {
      return { ok: false, reason: 'invalid_transition', message: 'Block reason must not be empty.' };
    }
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, input.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to block.' } as const,
        };
      }
      if (current.status === 'complete' || current.status === 'blocked') {
        return {
          next: current,
          result: {
            ok: false,
            reason: 'invalid_transition',
            message: `Cannot report a block for a ${current.status} goal.`,
          } as const,
        };
      }
      const repeatCount = countTrailingRepeatReasons(current.blockAudit, reason) + 1;
      const entry: Goal['blockAudit'][number] = {
        at,
        reason,
        ...(typeof input.turn === 'number' ? { turn: input.turn } : {}),
        repeat: repeatCount,
      };
      const next: Goal = {
        ...current,
        status: repeatCount >= BLOCK_REPEAT_THRESHOLD ? 'blocked' : 'active',
        blockAudit: [...current.blockAudit, entry].slice(-BLOCK_AUDIT_RETAIN),
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /**
   * Mark the goal complete. Runtime-only: requires evidence that the
   * completion criteria are met. The UI must not call this directly.
   */
  async requestCompletion(evidence: {
    note: string;
    evidenceRefs?: string[];
    expectedRevision?: number;
  }): Promise<GoalMutationResult> {
    const note = evidence.note.trim();
    if (!note) {
      return { ok: false, reason: 'invalid_transition', message: 'Completion evidence must not be empty.' };
    }
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, evidence.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to complete.' } as const,
        };
      }
      if (current.status !== 'active') {
        return {
          next: current,
          result: {
            ok: false,
            reason: 'invalid_transition',
            message: `Cannot request completion: goal is ${current.status}.`,
          } as const,
        };
      }
      const next: Goal = {
        ...current,
        completionRequest: {
          at,
          note,
          evidenceRefs: uniqueStrings(evidence.evidenceRefs ?? []),
        },
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** @deprecated Completion is now a runtime-settled request. */
  async complete(evidence: {
    note: string;
    evidenceRefs?: string[];
    expectedRevision?: number;
  }): Promise<GoalMutationResult> {
    return this.requestCompletion(evidence);
  }

  /** Settle one completed runtime turn and atomically account its usage. */
  async settleTurn(input: SettleGoalTurnInput): Promise<GoalMutationResult> {
    const at = input.receipt.at || this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to settle.' } as const,
        };
      }
      const observedRefs = new Set([
        ...current.evidence.flatMap(item => item.ref ? [item.ref] : []),
        ...input.evidence.flatMap(item => item.ref ? [item.ref] : []),
        ...(input.observedRefs ?? []),
      ]);
      const applied = applyWorkItemRequests(current, observedRefs, at);
      const completionRequest = current.completionRequest;
      const missingCompletionRefs = completionRequest?.evidenceRefs.filter(ref => !observedRefs.has(ref)) ?? [];
      const completionEvidenceSatisfied = Boolean(
        completionRequest
        && missingCompletionRefs.length === 0
        && (!current.completionCriteria?.trim() || completionRequest.evidenceRefs.length > 0),
      );
      const frontierClosed = goalFrontierClosed(applied.workItems) && Boolean(
        applied.noFollowupReason?.trim(),
      );
      const completionAccepted = input.completionAccepted === true
        || Boolean(completionRequest && completionEvidenceSatisfied && frontierClosed);
      const completionFailure = completionRequest && !completionAccepted
        ? missingCompletionRefs.length > 0
          ? `Completion evidence was not observed: ${missingCompletionRefs.join(', ')}`
          : !completionEvidenceSatisfied
            ? 'Completion criteria require runtime-observed evidence.'
            : 'Goal frontier is not terminal or lacks an explicit no-follow-up reason.'
        : undefined;
      const completionNote = completionRequest?.note;
      const nextEvidence = [...current.evidence, ...input.evidence];
      if (completionAccepted && completionNote) {
        nextEvidence.push({
          id: `goal-completion:${input.receipt.runId}`,
          at,
          note: completionNote,
          kind: 'validation',
          ref: input.receipt.id,
          verified: true,
        });
      }
      const replanAudit = settleReplanAudit(current, input, at);
      const repeatedReplan = replanAudit.at(-1);
      const replanBlocked = Boolean(
        repeatedReplan
        && !repeatedReplan.deltaRecorded
        && repeatedReplan.repeat >= BLOCK_REPEAT_THRESHOLD,
      );
      const effectiveReceipt: GoalTurnReceipt = completionAccepted
        ? { ...input.receipt, outcome: 'validated_completion', validation: { status: 'passed' } }
        : completionFailure || applied.validationFailure
          ? {
              ...input.receipt,
              outcome: 'validation_failed',
              validation: {
                status: 'failed',
                reason: completionFailure ?? applied.validationFailure,
              },
            }
          : input.replan && !input.replan.deltaRecorded
            ? { ...input.receipt, outcome: 'replan_required' }
            : input.receipt;
      const completedBefore = current.workItems.filter(item => item.status === 'done').length;
      const completedAfter = applied.workItems.filter(item => item.status === 'done').length;
      const validated = effectiveReceipt.validation.status === 'passed'
        || effectiveReceipt.outcome === 'validated_progress'
        || effectiveReceipt.outcome === 'validated_completion';
      const next: Goal = {
        ...current,
        status: completionAccepted && completionNote
          ? 'complete'
          : replanBlocked
            ? 'blocked'
            : current.status,
        consumption: {
          turns: current.consumption.turns + input.receipt.usage.turns,
          toolIterations: current.consumption.toolIterations + input.receipt.usage.toolIterations,
          tokens: current.consumption.tokens + input.receipt.usage.tokens,
        },
        delivery: {
          validatedTurns: current.delivery.validatedTurns + (validated ? 1 : 0),
          completedWorkItems: current.delivery.completedWorkItems
            + Math.max(0, completedAfter - completedBefore),
          evidenceItems: current.delivery.evidenceItems
            + input.evidence.filter(item => item.verified === true).length,
        },
        evidence: nextEvidence.slice(-EVIDENCE_RETAIN),
        turnReceipts: [...current.turnReceipts, effectiveReceipt].slice(-TURN_RECEIPT_RETAIN),
        completionRequest: undefined,
        workItems: applied.workItems,
        workItemRequests: [],
        planRevision: current.planRevision + (applied.changed ? 1 : 0),
        replanAudit,
        ...(input.replan?.deltaRecorded ? { forcedReplan: undefined } : {}),
        ...(applied.noFollowupReason ? { noFollowupReason: applied.noFollowupReason } : {}),
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /**
   * UI-driven status transition for pause/resume. These do not require
   * evidence (they are steering, not completion). `complete` and `blocked`
   * are NOT exposed here - only the runtime may set those, via `complete()`
   * and `block()`.
   */
  async transition(target: 'paused' | 'active' | 'cancelled'): Promise<GoalTransitionResult> {
    const at = this.now();
    return updateGoal<GoalTransitionResult>(this.port, at, current => {
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to update.' } as const,
        };
      }
      if (current.status === 'complete' || current.status === 'cancelled') {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: 'Cannot transition a completed goal.' } as const,
        };
      }
      if (current.status === target) {
        return { next: current, result: { ok: true, goal: current } as const };
      }
      const next: Goal = {
        ...current,
        status: target,
        ...(target === 'active' && current.status === 'blocked' ? { blockAudit: [] } : {}),
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }

  /** Update the objective/criteria text (steering). Revision-bumped. */
  async revise(input: {
    objective?: string;
    completionCriteria?: string;
    expectedRevision?: number;
  }): Promise<GoalMutationResult> {
    const at = this.now();
    return updateGoal<GoalMutationResult>(this.port, at, current => {
      const conflict = revisionConflict(current, input.expectedRevision);
      if (conflict) return { next: current ?? undefined, result: conflict };
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to revise.' } as const,
        };
      }
      const objective = input.objective?.trim() ?? current.objective;
      if (!objective) {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: 'Objective must not be empty.' } as const,
        };
      }
      const next: Goal = {
        ...current,
        objective,
        ...(input.completionCriteria !== undefined
          ? input.completionCriteria.trim()
            ? { completionCriteria: input.completionCriteria.trim() }
            : {}
          : current.completionCriteria
            ? { completionCriteria: current.completionCriteria }
            : {}),
        updatedAt: at,
        revision: current.revision + 1,
      };
      return { next, result: { ok: true, goal: next } as const };
    });
  }
}

const EVIDENCE_RETAIN = 50;
const BLOCK_AUDIT_RETAIN = 20;
const TURN_RECEIPT_RETAIN = 100;
const REPLAN_AUDIT_RETAIN = 30;

function createBootstrapWorkItem(objective: string, at: string): GoalWorkItem {
  return {
    id: 'goal-work:1',
    role: 'agent',
    priority: 'P0',
    taskClass: 'advancement',
    actionKind: 'advance',
    text: objective,
    status: 'open',
    dependsOn: [],
    evidenceRefs: [],
    createdAt: at,
    updatedAt: at,
  };
}

function normalizePlannedItems(
  inputs: PlanGoalItemInput[],
  at: string,
  retained: GoalWorkItem[],
): GoalWorkItem[] {
  if (inputs.length === 0) throw new Error('Goal plan must contain at least one item.');
  const used = new Set(retained.map(item => item.id));
  const items = inputs.map((input, index): GoalWorkItem => {
    const text = input.text.trim();
    if (!text) throw new Error(`Goal plan item ${index + 1} has empty text.`);
    const id = input.id?.trim() || `goal-work:${retained.length + index + 1}`;
    if (used.has(id)) throw new Error(`Duplicate Goal work item id: ${id}`);
    used.add(id);
    return {
      id,
      role: input.role ?? 'agent',
      priority: input.priority ?? (index === 0 ? 'P0' : 'P1'),
      taskClass: input.taskClass ?? (input.role === 'user' ? 'user_gate' : 'advancement'),
      actionKind: input.actionKind?.trim() || 'advance',
      text,
      status: 'open',
      dependsOn: uniqueStrings(input.dependsOn ?? []),
      evidenceRefs: [],
      ...(input.successorOf?.trim() ? { successorOf: input.successorOf.trim() } : {}),
      ...(input.resumeWhen?.trim() ? { resumeWhen: input.resumeWhen.trim() } : {}),
      createdAt: at,
      updatedAt: at,
    };
  });
  const known = new Set([...retained, ...items].map(item => item.id));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!known.has(dependency)) throw new Error(`Unknown Goal dependency ${dependency} for ${item.id}.`);
      if (dependency === item.id) throw new Error(`Goal work item ${item.id} cannot depend on itself.`);
    }
  }
  return [...retained, ...items];
}

function applyWorkItemRequests(
  goal: Goal,
  observedRefs: Set<string>,
  at: string,
): {
  workItems: GoalWorkItem[];
  changed: boolean;
  noFollowupReason?: string;
  validationFailure?: string;
} {
  if (goal.workItemRequests.length === 0) {
    return {
      workItems: goal.workItems,
      changed: false,
      ...(goal.noFollowupReason ? { noFollowupReason: goal.noFollowupReason } : {}),
    };
  }
  const workItems = goal.workItems.map(item => ({ ...item }));
  let changed = false;
  let noFollowupReason = goal.noFollowupReason;
  let validationFailure: string | undefined;
  for (const request of goal.workItemRequests) {
    const item = workItems.find(candidate => candidate.id === request.workItemId);
    if (!item) continue;
    const missing = request.evidenceRefs.filter(ref => !observedRefs.has(ref));
    if (request.status === 'done' && (missing.length > 0 || request.evidenceRefs.length === 0)) {
      validationFailure = missing.length > 0
        ? `Work-item evidence was not observed for ${item.id}: ${missing.join(', ')}`
        : `Completing ${item.id} requires runtime-observed evidence.`;
      continue;
    }
    item.status = request.status;
    item.evidenceRefs = uniqueStrings([...item.evidenceRefs, ...request.evidenceRefs]);
    item.updatedAt = at;
    if (request.resumeWhen) item.resumeWhen = request.resumeWhen;
    if (request.status === 'done' && request.noFollowupReason) {
      noFollowupReason = request.noFollowupReason;
    }
    changed = true;
  }
  return {
    workItems,
    changed,
    ...(noFollowupReason ? { noFollowupReason } : {}),
    ...(validationFailure ? { validationFailure } : {}),
  };
}

function goalFrontierClosed(workItems: GoalWorkItem[]): boolean {
  return workItems.length > 0 && workItems.every(item => item.status === 'done' || item.status === 'cancelled');
}

function settleReplanAudit(
  current: Goal,
  input: SettleGoalTurnInput,
  at: string,
): Goal['replanAudit'] {
  if (!input.replan) return current.replanAudit;
  const previous = current.replanAudit.at(-1);
  const repeat = !input.replan.deltaRecorded
    && previous?.frontierFingerprint === input.replan.frontierFingerprint
    && !previous.deltaRecorded
    ? previous.repeat + 1
    : input.replan.deltaRecorded ? 0 : 1;
  return [...current.replanAudit, {
    at,
    trigger: input.replan.trigger,
    frontierFingerprint: input.replan.frontierFingerprint,
    repeat,
    deltaRecorded: input.replan.deltaRecorded,
  }].slice(-REPLAN_AUDIT_RETAIN);
}

function frontierFingerprint(goal: Goal): string {
  return goal.workItems
    .map(item => `${item.id}:${item.status}:${item.dependsOn.join(',')}`)
    .join('|');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function countTrailingRepeatReasons(
  audit: Goal['blockAudit'],
  reason: string,
): number {
  let count = 0;
  for (let i = audit.length - 1; i >= 0; i -= 1) {
    if (audit[i]!.reason === reason) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function revisionConflict(
  current: Goal | null,
  expectedRevision: number | undefined,
): GoalMutationResult | undefined {
  if (typeof expectedRevision !== 'number' || !current || expectedRevision === current.revision) {
    return undefined;
  }
  return {
    ok: false,
    reason: 'conflict',
    message: `Goal revision ${current.revision} does not match expected ${expectedRevision}.`,
  };
}

/** Convenience: map a Goal status to a compact display marker. */
export function goalStatusMark(status: GoalStatus): string {
  switch (status) {
    case 'waiting_user': return '?';
    case 'waiting_external': return '◷';
    case 'cancelled': return '×';
    case 'active': return '▶';
    case 'paused': return '‖';
    case 'complete': return '✓';
    case 'blocked': return '⊘';
  }
}
