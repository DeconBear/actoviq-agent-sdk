import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DurableChildRecord } from '../src/orchestration/index.js';
import { SqliteDurableChildStore, SqliteStorageV2 } from '../src/node/index.js';

describe('SqliteDurableChildStore', () => {
  it('persists, enumerates, and CAS-updates children across connection restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-durable-child-'));
    const filename = path.join(root, 'children.sqlite');
    try {
      const firstStorage = await SqliteStorageV2.open({ filename });
      const first = new SqliteDurableChildStore({
        store: firstStorage.checkpoints,
        tenantId: 'tenant-a',
      });
      const record = childRecord();
      await first.create(record);
      await firstStorage.close();

      const secondStorage = await SqliteStorageV2.open({ filename });
      const second = new SqliteDurableChildStore({
        store: secondStorage.checkpoints,
        tenantId: 'tenant-a',
      });
      expect(await second.get('child-1')).toEqual(record);
      expect(await second.list('parent-1')).toEqual([record]);
      const running: DurableChildRecord = {
        ...record,
        revision: 1,
        status: 'running',
        attempts: 1,
        updatedAt: '2026-07-11T00:00:01.000Z',
      };
      await expect(second.compareAndSet('child-1', 0, running)).resolves.toBe(true);
      await expect(second.compareAndSet('child-1', 0, running)).resolves.toBe(false);
      expect(await second.get('child-1')).toEqual(running);
      await secondStorage.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function childRecord(): DurableChildRecord {
  return {
    schemaVersion: 1,
    childId: 'child-1',
    revision: 0,
    parent: {
      runId: 'parent-1',
      depth: 0,
      trace: { runId: 'parent-1', traceId: 'trace-1', spanId: 'span-1' },
      securityPolicy: { id: 'default' },
      tenantSession: { tenantId: 'tenant-a', namespace: 'background', sessionId: 'session-1' },
      workspacePolicy: { access: 'read-only' },
      budget: {
        limits: { maxChildRuns: 4, maxDepth: 2, maxTotalTokens: 10_000, maxCostUsd: 10 },
        childRunsStarted: 0,
        totalTokensUsed: 0,
        costUsdUsed: 0,
      },
      metadata: {},
    },
    agentId: 'worker',
    input: [{ type: 'text', role: 'user', text: 'work' }],
    metadata: {},
    effect: 'side-effect',
    idempotencyKey: 'child-1',
    failurePolicy: { mode: 'fail-fast' },
    status: 'queued',
    attempts: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}
