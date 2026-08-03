import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoalContinuationService } from '../src/goal/goalContinuation.js';
import { ProjectGoalApi } from '../src/goal/projectGoalApi.js';
import { GoalService } from '../src/goal/goalService.js';
import { ProjectGoalStore } from '../src/goal/projectGoalStore.js';
import type { AgentRunResult } from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-continuation-'));
  roots.push(directory);
  const store = await ProjectGoalStore.open(directory);
  const service = new GoalService({ port: store.portForSession('session-1') });
  await service.create({ objective: 'finish the project' });
  const record = store.readForSession('session-1')!;
  return { store, service, goalId: record.id };
}

function result(runId: string): AgentRunResult {
  return {
    runId,
    sessionId: 'session-1',
    model: 'test-model',
    text: 'continued',
    message: { id: `message-${runId}`, type: 'message', role: 'assistant', content: [] } as never,
    messages: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 } as never,
    requests: [],
    toolCalls: [],
    startedAt: '2026-08-04T00:00:00.000Z',
    completedAt: '2026-08-04T00:00:01.000Z',
  };
}

describe('Goal native continuation', () => {
  it('suppresses paused and not-due scheduled wakes deterministically', async () => {
    const { store, service, goalId } = await fixture();
    const now = new Date('2026-08-04T00:00:00.000Z');
    store.configureContinuation({
      goalId,
      mode: 'scheduled',
      minIntervalSeconds: 60,
      maxIntervalSeconds: 600,
      now,
    });
    const continuation = new GoalContinuationService(store, async () => result('never'));
    expect(continuation.decide(goalId, { now })).toMatchObject({ kind: 'skip', reason: 'not_due' });
    await service.transition('paused');
    expect(continuation.decide(goalId, { force: true, now })).toMatchObject({ kind: 'skip', reason: 'stopped' });
    store.close();
  });

  it('prevents duplicate wakes with a durable lease', async () => {
    const { store, goalId } = await fixture();
    store.configureContinuation({ goalId, mode: 'manual' });
    expect(store.acquireContinuationLease(goalId, 'worker-a')).toBe(true);
    expect(store.acquireContinuationLease(goalId, 'worker-b')).toBe(false);
    const continuation = new GoalContinuationService(store, async () => result('never'));
    expect(continuation.decide(goalId, { force: true })).toMatchObject({ kind: 'skip', reason: 'leased' });
    store.close();
  });

  it('backs off on no-change and accelerates after validated progress', async () => {
    const { store, service, goalId } = await fixture();
    store.configureContinuation({
      goalId,
      mode: 'scheduled',
      minIntervalSeconds: 10,
      maxIntervalSeconds: 80,
      now: new Date('2026-08-04T00:00:00.000Z'),
    });
    let calls = 0;
    const continuation = new GoalContinuationService(store, async () => {
      calls += 1;
      const runId = `run-${calls}`;
      await service.settleTurn({
        receipt: {
          id: `receipt-${calls}`,
          runId,
          workItemId: 'goal-work:1',
          at: `2026-08-04T00:00:0${calls}.000Z`,
          outcome: calls === 1 ? 'no_change' : 'validated_progress',
          evidenceRefs: calls === 1 ? [] : ['tool:verified'],
          validation: { status: calls === 1 ? 'not_applicable' : 'passed' },
          usage: { turns: 1, toolIterations: calls === 1 ? 0 : 1, tokens: 15 },
        },
        evidence: calls === 1 ? [] : [{
          at: `2026-08-04T00:00:0${calls}.000Z`,
          note: 'verified output',
          kind: 'tool_result',
          ref: 'tool:verified',
          verified: true,
        }],
      });
      return result(runId);
    });
    await continuation.run({ goalId, force: true });
    expect(store.continuationState(goalId)?.currentIntervalSeconds).toBe(20);
    await continuation.run({ goalId, force: true });
    expect(store.continuationState(goalId)?.currentIntervalSeconds).toBe(10);
    const goal = store.readSnapshot(goalId)!;
    expect(goal.consumption).toEqual({ turns: 2, toolIterations: 1, tokens: 30 });
    expect(goal.delivery).toEqual({ validatedTurns: 1, completedWorkItems: 0, evidenceItems: 1 });
    store.close();
  });

  it('runs foreground continuation until the frontier reaches an exact wait state', async () => {
    const { store, service, goalId } = await fixture();
    store.configureContinuation({ goalId, mode: 'foreground' });
    let calls = 0;
    const continuation = new GoalContinuationService(store, async () => {
      calls += 1;
      await service.requestWorkItemUpdate({
        workItemId: 'goal-work:1',
        status: 'deferred',
        note: 'waiting for CI',
        resumeWhen: 'CI run 42 reaches a terminal state',
      });
      await service.settleTurn({
        receipt: {
          id: 'receipt-wait', runId: 'run-wait', workItemId: 'goal-work:1',
          at: '2026-08-04T00:00:01.000Z', outcome: 'wait', evidenceRefs: [],
          validation: { status: 'not_applicable' },
          usage: { turns: 1, toolIterations: 0, tokens: 12 },
        },
        evidence: [],
      });
      return result('run-wait');
    });
    const run = await continuation.run({ goalId, force: true });
    expect(run.turns).toBe(1);
    expect(calls).toBe(1);
    expect(run.reason).toContain('CI run 42');
    store.close();
  });

  it('passes the configured project execution profile to the wake executor', async () => {
    const { store, service, goalId } = await fixture();
    store.configureContinuation({
      goalId,
      mode: 'manual',
      executionProfile: { kind: 'agent', name: 'goal-worker' },
    });
    let profile: unknown;
    const continuation = new GoalContinuationService(store, async input => {
      profile = input.executionProfile;
      await service.settleTurn({
        receipt: {
          id: 'receipt-profile', runId: 'run-profile', workItemId: 'goal-work:1',
          at: '2026-08-04T00:00:01.000Z', outcome: 'no_change', evidenceRefs: [],
          validation: { status: 'not_applicable' },
          usage: { turns: 1, toolIterations: 0, tokens: 1 },
        },
        evidence: [],
      });
      return result('run-profile');
    });
    await continuation.run({ goalId, force: true });
    expect(profile).toEqual({ kind: 'agent', name: 'goal-worker' });
    store.close();
  });

  it('restores a scheduled timer and performs one due background wake', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-scheduler-'));
    roots.push(directory);
    let api!: ProjectGoalApi;
    let resolveWake!: () => void;
    const woke = new Promise<void>(resolve => { resolveWake = resolve; });
    api = new ProjectGoalApi(directory, {
      continuationExecutor: async input => {
        const service = await api.serviceForSession({ id: input.sessionId, metadata: {} });
        await service.settleTurn({
          receipt: {
            id: 'scheduled-receipt', runId: 'scheduled-run', workItemId: 'goal-work:1',
            at: new Date().toISOString(), outcome: 'no_change', evidenceRefs: [],
            validation: { status: 'not_applicable' },
            usage: { turns: 1, toolIterations: 0, tokens: 2 },
          },
          evidence: [],
        });
        resolveWake();
        return result('scheduled-run');
      },
    });
    const activeSession = { id: 'scheduled-session', metadata: {} };
    await api.command(activeSession, 'start scheduled objective');
    await api.configureContinuation({
      sessionId: activeSession.id,
      mode: 'scheduled',
      minIntervalSeconds: 1,
      maxIntervalSeconds: 8,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await woke;
    expect((await api.status(activeSession.id)).goal?.consumption.turns).toBe(1);
    expect((await api.continuationStatus(activeSession.id))?.currentIntervalSeconds).toBe(2);
    await api.close();
  });
});
