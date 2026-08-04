import { describe, expect, it } from 'vitest';

import { executeGoalCommand } from '../src/goal/goalCommandService.js';
import { decideGoalExecution } from '../src/goal/goalController.js';
import { GoalService } from '../src/goal/goalService.js';
import { GOAL_METADATA_KEY, type GoalSessionPort } from '../src/goal/goalStore.js';
import type { Goal, GoalTurnReceipt } from '../src/goal/types.js';

class MemoryGoalPort implements GoalSessionPort {
  metadata: Record<string, unknown> = {};
  readGoalMetadata(): unknown { return this.metadata[GOAL_METADATA_KEY]; }
  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    if (value) this.metadata[GOAL_METADATA_KEY] = value;
    else delete this.metadata[GOAL_METADATA_KEY];
  }
}

function service(): GoalService {
  let tick = 0;
  return new GoalService({
    port: new MemoryGoalPort(),
    now: () => `2026-08-04T00:00:${String(++tick).padStart(2, '0')}Z`,
  });
}

function receipt(
  id: string,
  outcome: GoalTurnReceipt['outcome'],
  workItemId?: string,
): GoalTurnReceipt {
  return {
    id: `goal-turn:${id}`,
    runId: id,
    ...(workItemId ? { workItemId } : {}),
    at: `2026-08-04T00:01:${id.replace(/\D/gu, '').padStart(2, '0')}Z`,
    outcome,
    evidenceRefs: [],
    validation: { status: 'not_applicable' },
    usage: { turns: 1, toolIterations: 0, tokens: 10 },
  };
}

describe('Goal work frontier', () => {
  it('starts with one runnable bootstrap item', async () => {
    const svc = service();
    const goal = await svc.create({ objective: 'ship feature' });
    expect(goal.workItems).toHaveLength(1);
    expect(decideGoalExecution(goal)).toMatchObject({
      kind: 'run', mode: 'work', workItemId: 'goal-work:1',
    });
  });

  it('routes a user gate before dependent agent work and resumes after an answer', async () => {
    const svc = service();
    await svc.create({ objective: 'deploy' });
    await svc.plan({ items: [
      { id: 'approval', role: 'user', taskClass: 'user_gate', priority: 'P0', text: 'Approve deployment' },
      { id: 'deploy', priority: 'P0', text: 'Deploy', dependsOn: ['approval'] },
    ] });
    expect(decideGoalExecution(await svc.read())).toMatchObject({ kind: 'stop', reason: 'waiting_user' });
    await svc.answerUserGate('approval', 'approved for staging');
    expect(decideGoalExecution(await svc.read())).toMatchObject({ kind: 'run', workItemId: 'deploy' });
  });

  it('does not let a future user gate preempt runnable agent work', async () => {
    const svc = service();
    await svc.create({ objective: 'ship' });
    await svc.plan({ items: [
      { id: 'implement', priority: 'P0', text: 'Implement feature' },
      {
        id: 'approval',
        role: 'user',
        taskClass: 'user_gate',
        priority: 'P0',
        text: 'Approve release',
        dependsOn: ['implement'],
      },
    ] });
    expect(decideGoalExecution(await svc.read())).toMatchObject({
      kind: 'run',
      mode: 'work',
      workItemId: 'implement',
    });
  });

  it('skips work items claimed by another agent', async () => {
    const svc = service();
    await svc.create({ objective: 'parallel' });
    await svc.plan({ items: [
      { id: 'a', priority: 'P0', text: 'First' },
      { id: 'b', priority: 'P1', text: 'Second' },
    ] });
    expect(decideGoalExecution(await svc.read(), {
      unavailableWorkItemIds: new Set(['a']),
    })).toMatchObject({ kind: 'run', workItemId: 'b' });
    expect(decideGoalExecution(await svc.read(), {
      unavailableWorkItemIds: new Set(['a', 'b']),
    })).toMatchObject({ kind: 'stop', reason: 'waiting_external' });
  });

  it('waits on an exact deferred resume condition', async () => {
    const svc = service();
    await svc.create({ objective: 'watch CI' });
    await svc.requestWorkItemUpdate({
      workItemId: 'goal-work:1', status: 'deferred', note: 'waiting for CI',
      resumeWhen: 'CI run 42 reaches a terminal state',
    });
    await svc.settleTurn({ receipt: receipt('1', 'wait', 'goal-work:1'), evidence: [] });
    expect(decideGoalExecution(await svc.read())).toMatchObject({ kind: 'stop', reason: 'waiting_external' });
  });

  it('derives replan after two unchanged turns on the same work item', async () => {
    const svc = service();
    await svc.create({ objective: 'investigate' });
    await svc.settleTurn({ receipt: receipt('1', 'no_change', 'goal-work:1'), evidence: [] });
    await svc.settleTurn({ receipt: receipt('2', 'no_change', 'goal-work:1'), evidence: [] });
    expect(decideGoalExecution(await svc.read())).toMatchObject({
      kind: 'replan', trigger: 'no_progress:goal-work:1',
    });
  });

  it('blocks after three identical replans produce no frontier delta', async () => {
    const svc = service();
    await svc.create({ objective: 'investigate' });
    await svc.forceReplan('operator_requested');
    for (let index = 1; index <= 3; index += 1) {
      const decision = decideGoalExecution(await svc.read());
      expect(decision.kind).toBe('replan');
      if (decision.kind !== 'replan') throw new Error('expected replan');
      await svc.settleTurn({
        receipt: receipt(String(index), 'replan_required'),
        evidence: [],
        replan: {
          trigger: decision.trigger,
          frontierFingerprint: decision.frontierFingerprint,
          deltaRecorded: false,
        },
      });
    }
    expect((await svc.read())?.status).toBe('blocked');
  });

  it('does not treat an empty frontier as complete without no-follow-up', async () => {
    const svc = service();
    await svc.create({ objective: 'ship' });
    await svc.requestWorkItemUpdate({
      workItemId: 'goal-work:1', status: 'done', note: 'done', evidenceRefs: ['tool:ok'],
    });
    await svc.settleTurn({
      receipt: receipt('1', 'validated_progress', 'goal-work:1'),
      evidence: [{ at: 't', note: 'ok', ref: 'tool:ok', verified: true }],
    });
    expect(decideGoalExecution(await svc.read())).toMatchObject({
      kind: 'replan', trigger: 'terminal_no_followup_missing',
    });
  });
});

describe('shared Goal command service', () => {
  it('provides start, tasks, replan, gate answer, history, and cancellation commands', async () => {
    const svc = service();
    expect((await executeGoalCommand(svc, 'start Ship Goal v2')).message).toContain('goal started');
    expect((await executeGoalCommand(svc, 'tasks')).message).toContain('goal-work:1');
    expect((await executeGoalCommand(svc, 'replan improve plan')).changed).toBe(true);
    expect((await executeGoalCommand(svc, 'status')).message).toContain('replan');
    expect((await executeGoalCommand(svc, 'history')).message).toContain('no settled turns');
    expect((await executeGoalCommand(svc, 'cancel')).goal?.status).toBe('cancelled');
  });
});
