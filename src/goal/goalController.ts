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
  | { kind: 'run'; mode: 'work' | 'finalize'; workItemId?: string }
  | { kind: 'replan'; trigger: string; frontierFingerprint: string; planRevision: number }
  | { kind: 'stop'; reason: 'paused' | 'waiting_user' | 'waiting_external' | 'blocked' | 'complete' | 'cancelled' | 'budget_exhausted'; message: string };

export class GoalExecutionBlockedError extends Error {
  readonly code = 'goal_execution_blocked';

  constructor(readonly decision: Extract<GoalExecutionDecision, { kind: 'stop' }>) {
    super(decision.message);
    this.name = 'GoalExecutionBlockedError';
  }
}

export function decideGoalExecution(goal: Goal | null): GoalExecutionDecision {
  if (!goal) return { kind: 'run', mode: 'work' };
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
  if (goal.forcedReplan) return replanDecision(goal, goal.forcedReplan.reason);
  const completed = new Set(
    goal.workItems
      .filter(item => item.status === 'done' || item.status === 'cancelled')
      .map(item => item.id),
  );
  const userGate = goal.workItems.find(item => (
    item.role === 'user'
    && item.taskClass === 'user_gate'
    && item.status !== 'done'
    && item.status !== 'cancelled'
  ));
  if (userGate) {
    return {
      kind: 'stop',
      reason: 'waiting_user',
      message: `Goal requires user action for ${userGate.id}: ${userGate.text}`,
    };
  }
  const runnable = [...goal.workItems]
    .filter(item => (
      item.role === 'agent'
      && ['open', 'claimed', 'running'].includes(item.status)
      && item.dependsOn.every(id => completed.has(id))
    ))
    .sort(compareWorkItems)[0];
  if (runnable) {
    const noChangeCount = countTrailingNoChange(goal, runnable.id);
    if (noChangeCount >= 2) {
      return replanDecision(goal, `no_progress:${runnable.id}`);
    }
    return { kind: 'run', mode: 'work', workItemId: runnable.id };
  }
  if (goal.workItems.length > 0 && goal.workItems.every(item => (
    item.status === 'done' || item.status === 'cancelled'
  ))) {
    if (goal.noFollowupReason?.trim()) return { kind: 'run', mode: 'finalize' };
    return replanDecision(goal, 'terminal_no_followup_missing');
  }
  const deferred = goal.workItems.find(item => item.status === 'deferred');
  if (deferred) {
    return {
      kind: 'stop',
      reason: 'waiting_external',
      message: `Goal is waiting for ${deferred.id}: ${deferred.resumeWhen ?? deferred.text}`,
    };
  }
  return replanDecision(goal, 'frontier_empty_nonterminal');
}

export async function settleGoalRun(
  service: GoalService,
  result: AgentRunResult,
  decision: GoalExecutionDecision = { kind: 'run', mode: 'work' },
): Promise<void> {
  const goal = await service.read();
  if (!goal || goal.status !== 'active') return;

  const usage = goalUsage(result);
  const observedEvidence = observedToolEvidence(result);
  let outcome: GoalTurnOutcome = observedEvidence.length > 0
    ? 'validated_progress'
    : 'no_change';
  const validation: GoalTurnReceipt['validation'] = {
    status: observedEvidence.length > 0 ? 'passed' : 'not_applicable',
  };
  if (decision.kind === 'replan') outcome = 'replan_required';

  const receipt: GoalTurnReceipt = {
    id: `goal-turn:${result.runId}`,
    runId: result.runId,
    ...(decision.kind === 'run' && decision.workItemId ? { workItemId: decision.workItemId } : {}),
    at: result.completedAt,
    outcome,
    evidenceRefs: observedEvidence.flatMap(item => item.ref ? [item.ref] : []),
    validation,
    usage,
  };
  await service.settleTurn({
    receipt,
    evidence: observedEvidence,
    observedRefs: observedEvidence.flatMap(item => item.ref ? [item.ref] : []),
    ...(decision.kind === 'replan'
      ? {
          replan: {
            trigger: decision.trigger,
            frontierFingerprint: decision.frontierFingerprint,
            deltaRecorded: goal.planRevision > decision.planRevision,
          },
        }
      : {}),
  });
}

function compareWorkItems(a: Goal['workItems'][number], b: Goal['workItems'][number]): number {
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt);
}

function countTrailingNoChange(goal: Goal, workItemId: string): number {
  let count = 0;
  for (let index = goal.turnReceipts.length - 1; index >= 0; index -= 1) {
    const receipt = goal.turnReceipts[index]!;
    if (receipt.workItemId !== workItemId || receipt.outcome !== 'no_change') break;
    count += 1;
  }
  return count;
}

function replanDecision(goal: Goal, trigger: string): GoalExecutionDecision {
  return {
    kind: 'replan',
    trigger,
    frontierFingerprint: goal.workItems
      .map(item => `${item.id}:${item.status}:${item.dependsOn.join(',')}`)
      .join('|'),
    planRevision: goal.planRevision,
  };
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
