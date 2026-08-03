import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GoalService } from '../src/goal/goalService.js';
import { GoalWorkCoordinator } from '../src/goal/goalWorkCoordinator.js';
import { ProjectGoalStore } from '../src/goal/projectGoalStore.js';
import { AgentPool } from '../src/team/agentPool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-workers-'));
  roots.push(directory);
  const store = await ProjectGoalStore.open(directory);
  const service = new GoalService({ port: store.portForSession('root-session') });
  await service.create({ objective: 'multi-agent delivery' });
  await service.plan({
    items: [
      { id: 'backend', text: 'Implement backend', priority: 'P0', roleScopes: ['backend'], excludedAgentIds: ['blocked-agent'] },
      { id: 'frontend', text: 'Implement frontend', priority: 'P0', roleScopes: ['frontend'] },
    ],
  });
  return { store, service, goalId: store.readForSession('root-session')!.id };
}

describe('Goal multi-agent ownership', () => {
  it('enforces role scopes and explicit exclusions during atomic claims', async () => {
    const { store, goalId } = await fixture();
    const now = new Date('2026-08-04T00:00:00.000Z');
    expect(store.claimNextWork({
      goalId, agentId: 'blocked-agent', roleScopes: ['backend'], now,
    })).toBeUndefined();
    expect(store.claimNextWork({
      goalId, agentId: 'front-worker', roleScopes: ['backend'], now,
    })?.workItemId).toBe('backend');
    expect(store.claimNextWork({
      goalId, agentId: 'back-worker', roleScopes: ['backend'], now,
    })).toBeUndefined();
    expect(store.claimNextWork({
      goalId, agentId: 'ui-worker', roleScopes: ['frontend'], now,
    })?.workItemId).toBe('frontend');
    store.close();
  });

  it('allows takeover only after a lease expires', async () => {
    const { store, goalId } = await fixture();
    const start = new Date('2026-08-04T00:00:00.000Z');
    const first = store.claimNextWork({
      goalId, agentId: 'worker-a', roleScopes: ['backend'], leaseMs: 1_000, now: start,
    });
    expect(first).toBeTruthy();
    expect(store.claimNextWork({
      goalId, agentId: 'worker-b', roleScopes: ['backend'], now: new Date(start.getTime() + 999),
    })).toBeUndefined();
    const takeover = store.claimNextWork({
      goalId, agentId: 'worker-b', roleScopes: ['backend'], now: new Date(start.getTime() + 1_001),
    });
    expect(takeover?.workItemId).toBe('backend');
    expect(takeover?.claimToken).not.toBe(first?.claimToken);
    store.close();
  });

  it('records handoff receipts and rejects an out-of-scope target', async () => {
    const { store, goalId } = await fixture();
    const claim = store.claimNextWork({ goalId, agentId: 'worker-a', roleScopes: ['backend'] })!;
    expect(store.handoffWork({
      claimToken: claim.claimToken,
      reason: 'needs UI review',
      toAgentId: 'ui-worker',
      toAgentRoleScopes: ['frontend'],
      evidenceRefs: ['artifact:backend'],
    })).toBeUndefined();
    const handoff = store.handoffWork({
      claimToken: claim.claimToken,
      reason: 'backend review',
      toAgentId: 'worker-b',
      toAgentRoleScopes: ['backend'],
      evidenceRefs: ['artifact:backend'],
    });
    expect(handoff?.claim?.agentId).toBe('worker-b');
    expect(store.listHandoffs(goalId)).toMatchObject([{
      fromAgentId: 'worker-a',
      toAgentId: 'worker-b',
      evidenceRefs: ['artifact:backend'],
    }]);
    store.close();
  });

  it('uses AgentPool for bounded symmetric workers and releases every slot', async () => {
    const { store, goalId } = await fixture();
    const pool = new AgentPool(2);
    const coordinator = new GoalWorkCoordinator(store, pool);
    let running = 0;
    let peak = 0;
    const results = await coordinator.runWorkers({
      goalId,
      workers: [
        { agentId: 'backend-worker', roleScopes: ['backend'] },
        { agentId: 'frontend-worker', roleScopes: ['frontend'] },
        { agentId: 'spare-worker', roleScopes: ['backend', 'frontend'] },
      ],
      run: async claim => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 10));
        running -= 1;
        return { kind: 'completed', evidenceRefs: [`tool:${claim.workItemId}`] };
      },
    });
    expect(peak).toBe(2);
    expect(results.filter(item => item.outcome?.kind === 'completed')).toHaveLength(2);
    expect(results.filter(item => item.skipped)).toHaveLength(1);
    expect(pool.activeCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
    expect(store.readSnapshot(goalId)?.workItems.map(item => item.status)).toEqual(['done', 'done']);
    expect(store.listWorkClaims(goalId)).toEqual([]);
    store.close();
  });

  it('cleans outstanding claims when a Goal becomes terminal', async () => {
    const { store, service, goalId } = await fixture();
    const claim = store.claimNextWork({ goalId, agentId: 'worker', roleScopes: ['backend'] });
    expect(claim).toBeTruthy();
    await service.transition('cancelled');
    expect(store.listWorkClaims(goalId)).toEqual([]);
    store.close();
  });
});
