import type { AgentRunResult } from '../types.js';
import { GoalService } from './goalService.js';
import type {
  Goal,
  GoalBudgetConsumption,
  GoalEvidence,
  GoalTurnOutcome,
  GoalTurnReceipt,
} from './types.js';

export type GoalExecutionDecision =
  | { kind: 'run' }
  | { kind: 'stop'; reason: 'paused' | 'waiting_user' | 'waiting_external' | 'blocked' | 'complete' | 'cancelled' | 'budget_exhausted'; message: string };

export class GoalExecutionBlockedError extends Error {
  readonly code = 'goal_execution_blocked';

  constructor(readonly decision: Extract<GoalExecutionDecision, { kind: 'stop' }>) {
    super(decision.message);
    this.name = 'GoalExecutionBlockedError';
  }
}

export function decideGoalExecution(goal: Goal | null): GoalExecutionDecision {
  if (!goal) return { kind: 'run' };
  if (goal.status !== 'active') {
    return {
      kind: 'stop',
      reason: goal.status,
      message: `Goal is ${goal.status}; resume or replace it before running another Goal turn.`,
    };
  }
  const exhausted = exhaustedBudgetMetric(goal);
  if (exhausted) {
    return {
      kind: 'stop',
      reason: 'budget_exhausted',
      message: `Goal budget exhausted: ${exhausted}. Revise the budget or replace the Goal to continue.`,
    };
  }
  return { kind: 'run' };
}

export async function settleGoalRun(
  service: GoalService,
  result: AgentRunResult,
): Promise<void> {
  const goal = await service.read();
  if (!goal || goal.status !== 'active') return;

  const usage = goalUsage(result);
  const observedEvidence = observedToolEvidence(result);
  const observedRefs = new Set([
    ...goal.evidence.flatMap(item => item.ref ? [item.ref] : []),
    ...observedEvidence.flatMap(item => item.ref ? [item.ref] : []),
  ]);
  const request = goal.completionRequest;
  let outcome: GoalTurnOutcome = observedEvidence.length > 0
    ? 'validated_progress'
    : 'no_change';
  let validation: GoalTurnReceipt['validation'] = {
    status: observedEvidence.length > 0 ? 'passed' : 'not_applicable',
  };
  let completionAccepted = false;
  if (request) {
    const missing = request.evidenceRefs.filter(ref => !observedRefs.has(ref));
    const evidenceRequired = Boolean(goal.completionCriteria?.trim());
    if (missing.length > 0) {
      outcome = 'validation_failed';
      validation = {
        status: 'failed',
        reason: `Completion evidence was not observed: ${missing.join(', ')}`,
      };
    } else if (evidenceRequired && request.evidenceRefs.length === 0) {
      outcome = 'validation_failed';
      validation = {
        status: 'failed',
        reason: 'Completion criteria require at least one runtime-observed evidence reference.',
      };
    } else {
      completionAccepted = true;
      outcome = 'validated_completion';
      validation = { status: 'passed' };
    }
  }

  const receipt: GoalTurnReceipt = {
    id: `goal-turn:${result.runId}`,
    runId: result.runId,
    at: result.completedAt,
    outcome,
    evidenceRefs: observedEvidence.flatMap(item => item.ref ? [item.ref] : []),
    validation,
    usage,
  };
  await service.settleTurn({
    receipt,
    evidence: observedEvidence,
    completionAccepted,
  });
}

function exhaustedBudgetMetric(goal: Goal): string | undefined {
  const budget = goal.budget;
  if (!budget) return undefined;
  if (budget.maxTurns !== undefined && goal.consumption.turns >= budget.maxTurns) {
    return `maxTurns=${budget.maxTurns}`;
  }
  if (
    budget.maxToolIterations !== undefined
    && goal.consumption.toolIterations >= budget.maxToolIterations
  ) {
    return `maxToolIterations=${budget.maxToolIterations}`;
  }
  if (budget.maxTokens !== undefined && goal.consumption.tokens >= budget.maxTokens) {
    return `maxTokens=${budget.maxTokens}`;
  }
  return undefined;
}

function goalUsage(result: AgentRunResult): GoalBudgetConsumption {
  const usage = result.usage as Record<string, unknown> | undefined;
  const total = Number(usage?.totalTokens ?? usage?.total_tokens ?? 0)
    || Number(usage?.inputTokens ?? usage?.input_tokens ?? 0)
      + Number(usage?.outputTokens ?? usage?.output_tokens ?? 0);
  return {
    turns: 1,
    toolIterations: result.toolCalls.length,
    tokens: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0,
  };
}

function observedToolEvidence(result: AgentRunResult): GoalEvidence[] {
  return result.toolCalls
    .filter(call => !call.isError)
    .map(call => ({
      id: `goal-evidence:${call.id}`,
      at: call.completedAt,
      note: `${call.publicName || call.name} completed successfully.`,
      kind: 'tool_result' as const,
      ref: `tool:${call.id}`,
      verified: true,
    }));
}
