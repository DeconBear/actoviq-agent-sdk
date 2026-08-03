/**
 * Goal runtime contract - typed schema and status machine.
 *
 * A Goal is a project-scoped execution contract, not just a status label:
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
export type GoalStatus =
  | 'active'
  | 'waiting_user'
  | 'waiting_external'
  | 'paused'
  | 'complete'
  | 'blocked'
  | 'cancelled';

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

/** Runtime-observed budget consumption. Unlike GoalBudget, this is never model-authored. */
export interface GoalBudgetConsumption {
  turns: number;
  toolIterations: number;
  tokens: number;
}

/** A single piece of progress evidence recorded by the runtime. */
export interface GoalEvidence {
  /** Stable evidence identity for receipts and completion requests. */
  id?: string;
  /** ISO timestamp the evidence was recorded. */
  at: string;
  /** What changed since the last evidence entry. */
  note: string;
  /** Runtime-observed evidence category. */
  kind?: 'progress' | 'tool_result' | 'validation' | 'user_decision' | 'artifact';
  /** Durable or transcript-local reference, for example `tool:<call-id>`. */
  ref?: string;
  /** True only when the runtime observed and accepted the referenced result. */
  verified?: boolean;
  /** Tool calls counted this turn, if recorded by the runtime. */
  toolCalls?: number;
  /** Tokens consumed this turn, if recorded by the runtime. */
  tokens?: number;
}

export type GoalTurnOutcome =
  | 'validated_progress'
  | 'validated_completion'
  | 'no_change'
  | 'user_action_required'
  | 'wait'
  | 'replan_required'
  | 'validation_failed'
  | 'failed'
  | 'interrupted';

/** One runtime-observed Goal turn settlement. */
export interface GoalTurnReceipt {
  id: string;
  runId: string;
  workItemId?: string;
  at: string;
  outcome: GoalTurnOutcome;
  evidenceRefs: string[];
  validation: {
    status: 'passed' | 'failed' | 'not_applicable';
    reason?: string;
  };
  usage: GoalBudgetConsumption;
}

export type GoalWorkItemRole = 'agent' | 'user';
export type GoalWorkItemPriority = 'P0' | 'P1' | 'P2';
export type GoalWorkItemClass = 'advancement' | 'verification' | 'monitor' | 'user_gate';
export type GoalWorkItemStatus = 'open' | 'claimed' | 'running' | 'done' | 'deferred' | 'cancelled';

/** One executable item on the Goal frontier. */
export interface GoalWorkItem {
  id: string;
  role: GoalWorkItemRole;
  priority: GoalWorkItemPriority;
  taskClass: GoalWorkItemClass;
  actionKind: string;
  text: string;
  status: GoalWorkItemStatus;
  dependsOn: string[];
  evidenceRefs: string[];
  successorOf?: string;
  resumeWhen?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalWorkItemUpdateRequest {
  at: string;
  workItemId: string;
  status: 'open' | 'done' | 'deferred' | 'cancelled';
  note: string;
  evidenceRefs: string[];
  noFollowupReason?: string;
  resumeWhen?: string;
}

export interface GoalReplanAudit {
  at: string;
  trigger: string;
  frontierFingerprint: string;
  repeat: number;
  deltaRecorded: boolean;
}

/** A model may request completion; only the runtime may accept it. */
export interface GoalCompletionRequest {
  at: string;
  note: string;
  evidenceRefs: string[];
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
export const GOAL_SCHEMA_VERSION = 2;

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
  /** Runtime-owned cumulative usage across Goal turns. */
  consumption: GoalBudgetConsumption;
  /** Progress evidence, oldest first. */
  evidence: GoalEvidence[];
  /** Blocked audit entries, oldest first. */
  blockAudit: GoalBlockAudit[];
  /** Recent runtime turn settlements, oldest first. */
  turnReceipts: GoalTurnReceipt[];
  /** Pending model completion request, settled after the current turn. */
  completionRequest?: GoalCompletionRequest;
  /** Ordered executable frontier. */
  workItems: GoalWorkItem[];
  /** Pending model work-item updates, settled after the current turn. */
  workItemRequests: GoalWorkItemUpdateRequest[];
  /** Bumped whenever the ordered plan materially changes. */
  planRevision: number;
  /** Recent deterministic replan decisions. */
  replanAudit: GoalReplanAudit[];
  /** Explicit operator/runtime request to replan before more delivery work. */
  forcedReplan?: { at: string; reason: string };
  /** Explicit terminal closure when no successor remains. */
  noFollowupReason?: string;
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
