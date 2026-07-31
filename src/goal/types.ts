/**
 * Goal runtime contract - typed schema and status machine.
 *
 * A Goal is a session-scoped execution contract, not just a status label:
 * it carries an objective, completion criteria, a budget, progress evidence,
 * and a blocked audit. The runtime injects a short goal context into each
 * model turn, and only the runtime (via controlled tools) may mark a goal
 * complete or blocked - and only with evidence. UI surfaces read and steer
 * the same service; they never mutate goal state directly.
 *
 * Legacy sessions store a minimal `{ objective, status, setAt }` object under
 * `__hadamardGoal`; `goalStore` normalizes that into v1 on first read.
 */

/** Lifecycle states for a Goal. */
export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked';

/**
 * Execution budget. All fields optional - an unset limit means unbounded
 * (mirrors the SDK's default unlimited-iteration contract). When a budget is
 * set, the runtime records consumption and the service audits overruns.
 */
export interface GoalBudget {
  /** Maximum model turns allowed for this goal. */
  maxTurns?: number;
  /** Maximum tool iterations allowed. */
  maxToolIterations?: number;
  /** Soft token spend ceiling (input + output). */
  maxTokens?: number;
}

/** A single piece of progress evidence recorded by the runtime. */
export interface GoalEvidence {
  /** ISO timestamp the evidence was recorded. */
  at: string;
  /** What changed since the last evidence entry. */
  note: string;
  /** Tool calls counted this turn, if recorded by the runtime. */
  toolCalls?: number;
  /** Tokens consumed this turn, if recorded by the runtime. */
  tokens?: number;
}

/** An entry in the blocked audit - why the goal could not progress. */
export interface GoalBlockAudit {
  /** ISO timestamp the block was recorded. */
  at: string;
  /** Human-readable reason the goal is blocked. */
  reason: string;
  /** Runtime turn index when the block was detected. */
  turn?: number;
  /**
   * Consecutive repeat count for this reason. Set when the same reason
   * recurs BLOCK_REPEAT_THRESHOLD times in a row, so the runtime can surface
   * a "stuck" goal to the user.
   */
  repeat?: number;
}

/** Schema version for forward-compatible migration. */
export const GOAL_SCHEMA_VERSION = 1;

/** The persisted, versioned Goal contract. */
export interface Goal {
  /** Schema version for migration. */
  version: typeof GOAL_SCHEMA_VERSION;
  /** The objective the agent is working toward. */
  objective: string;
  /** Optional measurable completion criteria. */
  completionCriteria?: string;
  /** Current lifecycle status. */
  status: GoalStatus;
  /** Optional execution budget. */
  budget?: GoalBudget;
  /** Progress evidence, oldest first. */
  evidence: GoalEvidence[];
  /** Blocked audit entries, oldest first. */
  blockAudit: GoalBlockAudit[];
  /** ISO timestamp the goal was created. */
  createdAt: string;
  /** ISO timestamp the goal was last updated. */
  updatedAt: string;
  /** Monotonic revision counter; bumped on every mutation for conflict detection. */
  revision: number;
}

/** Discriminated result of a goal mutation. */
export type GoalMutationResult =
  | { ok: true; goal: Goal }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_transition'; message: string };
