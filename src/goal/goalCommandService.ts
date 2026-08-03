import { decideGoalExecution } from './goalController.js';
import { GoalService } from './goalService.js';
import type { Goal, GoalMutationResult } from './types.js';

export interface GoalCommandResult {
  ok: boolean;
  message: string;
  changed: boolean;
  goal: Goal | null;
}

/** Shared `/goal` command service used by CLI, TUI, and GUI. */
export async function executeGoalCommand(
  service: GoalService,
  rawArgs: string,
): Promise<GoalCommandResult> {
  const args = rawArgs.trim();
  const [command = '', ...rest] = splitArgs(args);
  const tail = rest.join(' ').trim();

  if (!args || command === 'status') return statusResult(await service.read());
  if (command === 'clear') {
    await service.clear();
    return { ok: true, changed: true, message: 'goal cleared', goal: null };
  }
  if (command === 'pause' || command === 'resume' || command === 'cancel') {
    const target = command === 'pause' ? 'paused' : command === 'cancel' ? 'cancelled' : 'active';
    return mutationResult(await service.transition(target), `${command}d`);
  }
  if (command === 'tasks' || command === 'plan') {
    const goal = await service.read();
    if (!goal) return noGoal();
    return { ok: true, changed: false, message: formatTasks(goal), goal };
  }
  if (command === 'history') {
    const goal = await service.read();
    if (!goal) return noGoal();
    return { ok: true, changed: false, message: formatHistory(goal), goal };
  }
  if (command === 'replan') {
    return mutationResult(await service.forceReplan(tail || 'operator_requested'), 'replan requested');
  }
  if (command === 'answer') {
    const [workItemId = '', ...answerParts] = rest;
    const answer = answerParts.join(' ').trim();
    if (!workItemId || !answer) {
      return { ok: false, changed: false, message: 'usage: /goal answer <gate-id> <answer>', goal: await service.read() };
    }
    return mutationResult(await service.answerUserGate(workItemId, answer), 'user gate resolved');
  }
  if (command === 'run') {
    let goal = await service.read();
    if (!goal) return noGoal();
    if (goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'waiting_user' || goal.status === 'waiting_external') {
      const resumed = await service.transition('active');
      if (!resumed.ok) return mutationResult(resumed, 'resumed');
      goal = resumed.goal;
    }
    return {
      ok: true,
      changed: false,
      message: `next decision: ${formatDecision(decideGoalExecution(goal))}`,
      goal,
    };
  }
  if (command === 'complete' || command === 'done') {
    return {
      ok: false,
      changed: false,
      message: 'goal completion requires a runtime-settled request with evidence',
      goal: await service.read(),
    };
  }

  const objective = command === 'start' ? tail : args;
  if (!objective) {
    return { ok: false, changed: false, message: 'usage: /goal start <objective>', goal: await service.read() };
  }
  const goal = await service.create({ objective });
  return {
    ok: true,
    changed: true,
    message: `goal started: ${objective}\n${formatTasks(goal)}`,
    goal,
  };
}

function splitArgs(value: string): string[] {
  return value.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(item => item.replace(/^["']|["']$/gu, '')) ?? [];
}

function statusResult(goal: Goal | null): GoalCommandResult {
  if (!goal) return noGoal();
  return {
    ok: true,
    changed: false,
    goal,
    message: [
      `${goal.status} · ${goal.objective}`,
      `revision ${goal.revision} · plan ${goal.planRevision}`,
      `used ${goal.consumption.turns} turns / ${goal.consumption.toolIterations} tools / ${goal.consumption.tokens} tokens`,
      `delivered ${goal.delivery.validatedTurns} validated turns / ${goal.delivery.completedWorkItems} completed items / ${goal.delivery.evidenceItems} evidence items`,
      `next decision: ${formatDecision(decideGoalExecution(goal))}`,
      formatTasks(goal),
    ].join('\n'),
  };
}

function formatTasks(goal: Goal): string {
  if (goal.workItems.length === 0) return 'tasks: none';
  return [
    'tasks:',
    ...goal.workItems.map(item => (
      `  ${item.status === 'done' ? '[x]' : item.status === 'cancelled' ? '[-]' : '[ ]'} ${item.id} ${item.priority} ${item.role}/${item.taskClass} · ${item.text}`
    )),
  ].join('\n');
}

function formatHistory(goal: Goal): string {
  if (goal.turnReceipts.length === 0) return 'goal history: no settled turns';
  return [
    'goal history:',
    ...goal.turnReceipts.slice(-20).map(receipt => (
      `  ${receipt.at} ${receipt.outcome}${receipt.workItemId ? ` · ${receipt.workItemId}` : ''} · ${receipt.usage.tokens} tokens`
    )),
  ].join('\n');
}

function formatDecision(decision: ReturnType<typeof decideGoalExecution>): string {
  if (decision.kind === 'run') return decision.workItemId
    ? `run ${decision.workItemId}`
    : `run ${decision.mode}`;
  if (decision.kind === 'replan') return `replan (${decision.trigger})`;
  return `${decision.reason} (${decision.message})`;
}

function mutationResult(result: GoalMutationResult, success: string): GoalCommandResult {
  if (!result.ok) return { ok: false, changed: false, message: result.message, goal: null };
  return { ok: true, changed: true, message: success, goal: result.goal };
}

function noGoal(): GoalCommandResult {
  return { ok: false, changed: false, message: 'no goal set — use /goal start <objective>', goal: null };
}
