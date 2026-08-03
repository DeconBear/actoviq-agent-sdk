import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { GoalService } from '../../src/goal/goalService.js';
import { GoalWorkCoordinator } from '../../src/goal/goalWorkCoordinator.js';
import { ProjectGoalStore } from '../../src/goal/projectGoalStore.js';
import { AgentPool } from '../../src/team/agentPool.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-benchmark-'));
try {
  const longHorizon = await benchmarkLongHorizon(path.join(root, 'long-horizon'));
  const isolation = await benchmarkIsolation(path.join(root, 'isolation'));
  process.stdout.write(`${JSON.stringify({ benchmark: 'goal-v2', longHorizon, isolation }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function benchmarkLongHorizon(directory: string) {
  const store = await ProjectGoalStore.open(directory);
  try {
    const service = new GoalService({ port: store.portForSession('benchmark-session') });
    await service.create({ objective: 'Complete a long project frontier' });
    const itemCount = 200;
    await service.plan({
      items: Array.from({ length: itemCount }, (_, index) => ({
        id: `item-${index + 1}`,
        text: `Deliver independent item ${index + 1}`,
        priority: index < 20 ? 'P0' as const : index < 100 ? 'P1' as const : 'P2' as const,
        roleScopes: [`lane-${index % 8}`],
      })),
    });
    const goalId = store.readForSession('benchmark-session')!.id;
    const coordinator = new GoalWorkCoordinator(store, new AgentPool(8));
    const started = performance.now();
    const results = await coordinator.runWorkers({
      goalId,
      workers: Array.from({ length: itemCount }, (_, index) => ({
        agentId: `worker-${index + 1}`,
        roleScopes: [`lane-${index % 8}`],
      })),
      run: async claim => ({ kind: 'completed', evidenceRefs: [`benchmark:${claim.workItemId}`] }),
    });
    const durationMs = performance.now() - started;
    const goal = store.readSnapshot(goalId)!;
    const completed = goal.workItems.filter(item => item.status === 'done').length;
    if (completed !== itemCount || results.some(result => result.error)) {
      throw new Error(`Long-horizon Goal benchmark failed: ${completed}/${itemCount} completed.`);
    }
    return {
      itemCount,
      completed,
      durationMs: Number(durationMs.toFixed(2)),
      itemsPerSecond: Number((itemCount / (durationMs / 1_000)).toFixed(2)),
      finalRevision: goal.revision,
      planRevision: goal.planRevision,
    };
  } finally {
    store.close();
  }
}

async function benchmarkIsolation(directory: string) {
  const stores = await Promise.all([
    ProjectGoalStore.open(path.join(directory, 'project-a')),
    ProjectGoalStore.open(path.join(directory, 'project-b')),
  ]);
  try {
    const started = performance.now();
    const services = stores.map(store => new GoalService({ port: store.portForSession('shared-session-id') }));
    await Promise.all([
      services[0]!.create({ objective: 'Project A only' }),
      services[1]!.create({ objective: 'Project B only' }),
    ]);
    const objectives = stores.map(store => store.readForSession('shared-session-id')?.goal.objective);
    if (objectives[0] !== 'Project A only' || objectives[1] !== 'Project B only') {
      throw new Error(`Project isolation failed: ${objectives.join(' / ')}`);
    }
    return {
      projects: 2,
      sharedSessionId: true,
      isolated: true,
      durationMs: Number((performance.now() - started).toFixed(2)),
    };
  } finally {
    for (const store of stores) store.close();
  }
}
