/**
 * Goal runtime contract - public exports.
 *
 * A Goal is a session-scoped execution contract: objective, status, budget,
 * progress evidence, and a blocked audit. `GoalService` is the single
 * authority over lifecycle; the runtime injects `buildGoalPrompt` each turn;
 * `createGoalTools` exposes GetGoal/CreateGoal/UpdateGoal to the agent.
 */
export type {
  Goal,
  GoalBlockAudit,
  GoalBudget,
  GoalBudgetConsumption,
  GoalCompletionRequest,
  GoalEvidence,
  GoalMutationResult,
  GoalStatus,
  GoalTurnOutcome,
  GoalTurnReceipt,
} from './types.js';
export { GOAL_SCHEMA_VERSION } from './types.js';
export {
  AgentSessionGoalPort,
  GOAL_METADATA_KEY,
  StoredSessionGoalPort,
  type GoalSessionPort,
  type GoalStorePort,
  normalizeGoal,
  readGoal,
  writeGoal,
} from './goalStore.js';
export {
  GoalService,
  type BlockGoalInput,
  type CreateGoalInput,
  type GoalClock,
  type GoalServiceOptions,
  type GoalTransitionResult,
  type ProgressGoalInput,
  type SettleGoalTurnInput,
  goalStatusMark,
} from './goalService.js';
export { buildGoalPrompt, type GoalPromptOptions } from './goalPrompt.js';
export {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  GOAL_TOOLS_PROMPT,
  UPDATE_GOAL_TOOL_NAME,
  createGoalTools,
  type GoalToolContext,
} from './goalTools.js';
export {
  GoalExecutionBlockedError,
  decideGoalExecution,
  settleGoalRun,
  type GoalExecutionDecision,
} from './goalController.js';
