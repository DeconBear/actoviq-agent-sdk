/**
 * goalPrompt - builds the short goal context injected into each model turn.
 *
 * The prompt is deliberately compact: objective, status, completion criteria,
 * and the most recent evidence note (not the full history). This keeps the
 * per-turn token cost bounded while giving the model a stable steering signal.
 * Budget consumption is summarized, not itemized.
 */
import type { Goal, GoalBudget } from './types.js';

export interface GoalPromptOptions {
  /** Maximum characters for the objective + criteria section. */
  maxObjectiveChars?: number;
}

const DEFAULT_MAX_OBJECTIVE_CHARS = 600;

/** Build the short goal context, or undefined if there is no active goal. */
export function buildGoalPrompt(
  goal: Goal | null,
  options: GoalPromptOptions = {},
): string | undefined {
  if (!goal) return undefined;
  // Paused/complete/blocked goals still surface so the model knows the state,
  // but a complete goal does not steer further work.
  if (goal.status === 'complete') return undefined;

  const limit = options.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS;
  const lines: string[] = ['## Active goal'];
  lines.push(`objective: ${truncate(goal.objective, limit)}`);
  if (goal.completionCriteria) {
    lines.push(`completion criteria: ${truncate(goal.completionCriteria, limit)}`);
  }
  lines.push(`status: ${goal.status}`);
  if (goal.budget) {
    lines.push(`budget: ${formatBudget(goal.budget)}; used: ${formatConsumption(goal)}`);
  }
  const latest = goal.evidence[goal.evidence.length - 1];
  if (latest) {
    lines.push(`last progress: ${truncate(latest.note, 240)}`);
  }
  if (goal.status === 'blocked') {
    const lastBlock = goal.blockAudit[goal.blockAudit.length - 1];
    if (lastBlock) {
      lines.push(`blocked reason: ${truncate(lastBlock.reason, 240)}`);
      if (lastBlock.repeat) {
        lines.push(`(this reason has repeated ${lastBlock.repeat}x - consider escalating to the user)`);
      }
    }
  }
  if (goal.status === 'waiting_user' || goal.status === 'waiting_external' || goal.status === 'paused') {
    lines.push('Do not continue Goal work until the runtime resumes this Goal.');
  } else {
    lines.push('When the objective is met, request completion with UpdateGoal and cite runtime-observed evidence refs such as tool:<call-id>. The runtime validates the request after the turn. If the same blocking condition prevents progress for three consecutive Goal turns, report each turn with UpdateGoal status "blocked" and the same concrete reason.');
  }
  return lines.join('\n');
}

function formatConsumption(goal: Goal): string {
  return `${goal.consumption.turns} turns, ${goal.consumption.toolIterations} tool iterations, ${goal.consumption.tokens} tokens`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function formatBudget(budget: GoalBudget): string {
  const parts: string[] = [];
  if (typeof budget.maxTurns === 'number') parts.push(`${budget.maxTurns} turns`);
  if (typeof budget.maxToolIterations === 'number') parts.push(`${budget.maxToolIterations} tool iterations`);
  if (typeof budget.maxTokens === 'number') parts.push(`${budget.maxTokens} tokens`);
  return parts.length > 0 ? parts.join(', ') : 'unbounded';
}
