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

export interface DecideGoalExecutionOptions {
  /** Work items owned by another agent (active claims) — skipped when selecting runnable work. */
  unavailableWorkItemIds?: ReadonlySet<string>;
}

export class GoalExecutionBlockedError extends Error {
  readonly code = 'goal_execution_blocked';

  constructor(readonly decision: Extract<GoalExecutionDecision, { kind: 'stop' }>) {
    super(decision.message);
    this.name = 'GoalExecutionBlockedError';
  }
}

/** Read-only / exploratory tools never count as validated delivery progress. */
const EXPLORATORY_TOOL_NAMES = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'search',
  'websearch',
  'webfetch',
  'tavilysearch',
  'getgoal',
  'askuserquestion',
  'toolsearch',
  'listmcpresources',
  'readmcpresource',
]);

export function decideGoalExecution(
  goal: Goal | null,
  options: DecideGoalExecutionOptions = {},
): GoalExecutionDecision {
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
  // Only a ready user gate (dependencies satisfied) blocks execution. A future
  // gate that still depends on unfinished agent work must not preempt that work.
  const userGate = goal.workItems.find(item => (
    item.role === 'user'
    && item.taskClass === 'user_gate'
    && item.status !== 'done'
    && item.status !== 'cancelled'
    && item.dependsOn.every(id => completed.has(id))
  ));
  if (userGate) {
    return {
      kind: 'stop',
      reason: 'waiting_user',
      message: `Goal requires user action for ${userGate.id}: ${userGate.text}`,
    };
  }
  const unavailable = options.unavailableWorkItemIds ?? new Set<string>();
  const runnable = [...goal.workItems]
    .filter(item => (
      item.role === 'agent'
      && ['open', 'claimed', 'running'].includes(item.status)
      && item.dependsOn.every(id => completed.has(id))
      && !unavailable.has(item.id)
    ))
    .sort(compareWorkItems)[0];
  if (runnable) {
    const noChangeCount = countTrailingNoChange(goal, runnable.id);
    if (noChangeCount >= 2) {
      return replanDecision(goal, `no_progress:${runnable.id}`);
    }
    return { kind: 'run', mode: 'work', workItemId: runnable.id };
  }
  if (unavailable.size > 0) {
    const claimedRunnable = goal.workItems.find(item => (
      item.role === 'agent'
      && ['open', 'claimed', 'running'].includes(item.status)
      && item.dependsOn.every(id => completed.has(id))
      && unavailable.has(item.id)
    ));
    if (claimedRunnable) {
      return {
        kind: 'stop',
        reason: 'waiting_external',
        message: `Goal work item ${claimedRunnable.id} is claimed by another agent.`,
      };
    }
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
  const progressEvidence = progressToolEvidence(result);
  let outcome: GoalTurnOutcome = progressEvidence.length > 0
    ? 'validated_progress'
    : 'no_change';
  const validation: GoalTurnReceipt['validation'] = {
    status: progressEvidence.length > 0 ? 'passed' : 'not_applicable',
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

/** Record an interrupted or failed Goal turn and reopen the running work item. */
export async function settleGoalRunFailure(
  service: GoalService,
  input: {
    runId: string;
    workItemId?: string;
    outcome: 'interrupted' | 'failed';
    message?: string;
    at?: string;
  },
): Promise<void> {
  const goal = await service.read();
  if (!goal || goal.status !== 'active') return;
  const at = input.at ?? new Date().toISOString();
  await service.settleTurn({
    receipt: {
      id: `goal-turn:${input.runId}`,
      runId: input.runId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      at,
      outcome: input.outcome,
      evidenceRefs: [],
      validation: {
        status: 'not_applicable',
        ...(input.message ? { reason: input.message.slice(0, 500) } : {}),
      },
      usage: { turns: 1, toolIterations: 0, tokens: 0 },
    },
    evidence: [],
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
  if (
    budget.maxValidatedTurns !== undefined
    && goal.delivery.validatedTurns >= budget.maxValidatedTurns
  ) {
    return `maxValidatedTurns=${budget.maxValidatedTurns}`;
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

function progressToolEvidence(result: AgentRunResult): GoalEvidence[] {
  return result.toolCalls
    .filter(call => !call.isError && !isExploratoryTool(call.publicName || call.name))
    .map(call => ({
      id: `goal-evidence:${call.id}`,
      at: call.completedAt,
      note: `${call.publicName || call.name} completed successfully.`,
      kind: 'tool_result' as const,
      ref: `tool:${call.id}`,
      verified: true,
    }));
}

export function isExploratoryTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (EXPLORATORY_TOOL_NAMES.has(normalized)) return true;
  // MCP resource readers are exploratory unless they mutate.
  if (normalized.startsWith('mcp__') && /(read|list|get|search|fetch|glob|grep)/u.test(normalized)) {
    return true;
  }
  return false;
}
