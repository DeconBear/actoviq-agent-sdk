import { describe, expect, it } from 'vitest';

import {
  GoalExecutionBlockedError,
  decideGoalExecution,
  settleGoalRun,
} from '../src/goal/goalController.js';
import { GoalService } from '../src/goal/goalService.js';
import { GOAL_METADATA_KEY, type GoalSessionPort } from '../src/goal/goalStore.js';
import type { Goal } from '../src/goal/types.js';
import type { AgentRunResult } from '../src/types.js';

class MemoryGoalPort implements GoalSessionPort {
  metadata: Record<string, unknown> = {};
  readGoalMetadata(): unknown { return this.metadata[GOAL_METADATA_KEY]; }
  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    if (value) this.metadata[GOAL_METADATA_KEY] = value;
    else delete this.metadata[GOAL_METADATA_KEY];
  }
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    runId: 'run-1',
    model: 'test-model',
    text: 'done',
    message: { id: 'm1', type: 'message', role: 'assistant', content: [] } as never,
    messages: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 80, output_tokens: 20 } as never,
    requests: [],
    toolCalls: [],
    startedAt: '2026-08-04T00:00:00Z',
    completedAt: '2026-08-04T00:00:01Z',
    ...overrides,
  };
}

describe('Goal runtime controller', () => {
  it('blocks non-active goals and exhausted budgets before a model request', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'ship', budget: { maxTurns: 0 } });
    const decision = decideGoalExecution(await service.read());
    expect(decision).toMatchObject({ kind: 'stop', reason: 'budget_exhausted' });
    expect(() => {
      if (decision.kind === 'stop') throw new GoalExecutionBlockedError(decision);
    }).toThrow(/budget exhausted/i);

    await service.clear();
    await service.create({ objective: 'ship' });
    await service.transition('paused');
    expect(decideGoalExecution(await service.read())).toMatchObject({ kind: 'stop', reason: 'paused' });
  });

  it('accounts runtime usage without copying assistant text into progress evidence', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'ship' });
    await settleGoalRun(service, result());
    const goal = (await service.read())!;
    expect(goal.consumption).toEqual({ turns: 1, toolIterations: 0, tokens: 100 });
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('no_change');
    expect(goal.evidence).toEqual([]);
  });

  it('rejects completion when requested evidence was not observed', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'ship', completionCriteria: 'tests pass' });
    await service.requestCompletion({ note: 'done', evidenceRefs: ['tool:missing'] });
    await settleGoalRun(service, result());
    const goal = (await service.read())!;
    expect(goal.status).toBe('active');
    expect(goal.completionRequest).toBeUndefined();
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('validation_failed');
  });

  it('accepts completion when the requested successful tool result exists', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'ship', completionCriteria: 'tests pass' });
    await service.requestWorkItemUpdate({
      workItemId: 'goal-work:1',
      status: 'done',
      note: 'tests passed',
      evidenceRefs: ['tool:call-1'],
      noFollowupReason: 'All requested work and validation are complete.',
    });
    await service.requestCompletion({ note: 'tests passed', evidenceRefs: ['tool:call-1'] });
    await settleGoalRun(service, result({
      toolCalls: [{
        id: 'call-1', name: 'Bash', publicName: 'Bash', provider: 'local', input: {},
        startedAt: '2026-08-04T00:00:00Z', completedAt: '2026-08-04T00:00:01Z',
        outputText: 'ok', isError: false, durationMs: 1,
      }],
    }));
    const goal = (await service.read())!;
    expect(goal.status).toBe('complete');
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('validated_completion');
    expect(goal.evidence.some(item => item.ref === 'tool:call-1' && item.verified)).toBe(true);
  });

  it('does not treat exploratory Read/Glob success as validated progress', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'investigate' });
    await settleGoalRun(service, result({
      toolCalls: [
        {
          id: 'read-1', name: 'Read', publicName: 'Read', provider: 'local', input: {},
          startedAt: '2026-08-04T00:00:00Z', completedAt: '2026-08-04T00:00:01Z',
          outputText: 'file', isError: false, durationMs: 1,
        },
        {
          id: 'glob-1', name: 'Glob', publicName: 'Glob', provider: 'local', input: {},
          startedAt: '2026-08-04T00:00:01Z', completedAt: '2026-08-04T00:00:02Z',
          outputText: 'paths', isError: false, durationMs: 1,
        },
      ],
    }), { kind: 'run', mode: 'work', workItemId: 'goal-work:1' });
    const goal = (await service.read())!;
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('no_change');
    expect(goal.delivery.validatedTurns).toBe(0);
    expect(goal.evidence).toHaveLength(2);
  });

  it('reopens a running work item after an interrupted failure settlement', async () => {
    const port = new MemoryGoalPort();
    const service = new GoalService({ port });
    await service.create({ objective: 'ship' });
    await service.beginWorkItem('goal-work:1');
    expect((await service.read())!.workItems[0]?.status).toBe('running');
    const { settleGoalRunFailure } = await import('../src/goal/goalController.js');
    await settleGoalRunFailure(service, {
      runId: 'run-abort',
      workItemId: 'goal-work:1',
      outcome: 'interrupted',
      message: 'aborted',
    });
    const goal = (await service.read())!;
    expect(goal.workItems[0]?.status).toBe('open');
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('interrupted');
  });
});
