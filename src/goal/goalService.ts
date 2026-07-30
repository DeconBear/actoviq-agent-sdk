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
} from './types.js';

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
      version: 1,
      objective,
      status: 'active',
      evidence: [],
      blockAudit: [],
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
  async complete(evidence: { note: string; expectedRevision?: number }): Promise<GoalMutationResult> {
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
      if (current.status === 'complete') {
        return {
          next: current,
          result: { ok: false, reason: 'invalid_transition', message: 'Goal is already complete.' } as const,
        };
      }
      const entry: GoalEvidence = { at, note };
      const next: Goal = {
        ...current,
        status: 'complete',
        evidence: [...current.evidence, entry].slice(-EVIDENCE_RETAIN),
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
  async transition(target: 'paused' | 'active'): Promise<GoalTransitionResult> {
    const at = this.now();
    return updateGoal<GoalTransitionResult>(this.port, at, current => {
      if (!current) {
        return {
          next: undefined,
          result: { ok: false, reason: 'not_found', message: 'No goal to update.' } as const,
        };
      }
      if (current.status === 'complete') {
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
    case 'active': return '▶';
    case 'paused': return '‖';
    case 'complete': return '✓';
    case 'blocked': return '⊘';
  }
}
