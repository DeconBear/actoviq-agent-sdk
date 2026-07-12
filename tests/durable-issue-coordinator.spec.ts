import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSpec, JsonValue } from '../src/core/index.js';
import { DurableIssueCoordinator } from '../src/issues/durableIssueCoordinator.js';
import { SqliteDurableChildStore, SqliteStorageV2 } from '../src/node/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const issueAgent: AgentSpec<JsonValue | undefined, JsonValue> = {
  id: 'product:issue-worker',
  name: 'Issue worker',
  instructions: 'Execute a persisted issue dispatch.',
};

describe('DurableIssueCoordinator', () => {
  it('routes live issue work through a durable child record', async () => {
    const storage = await SqliteStorageV2.open({ filename: ':memory:' });
    const execute = vi.fn(async () => ({ output: 'done' as JsonValue }));
    const coordinator = new DurableIssueCoordinator({
      store: new SqliteDurableChildStore({ store: storage.checkpoints, tenantId: 'tenant-a' }),
      executor: execute,
    });

    const result = await coordinator.run({
      childId: 'issue-child-live',
      parentRunId: 'issue-parent-live',
      agent: issueAgent,
      input: 'implement ISS-1',
      context: { issueId: 'ISS-1' },
      sessionId: 'session-1',
      workspaceRoot: 'C:/workspace',
    });

    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(execute).toHaveBeenCalledOnce();
    expect(await coordinator.query('issue-child-live')).toMatchObject({
      status: 'completed',
      agentId: issueAgent.id,
      context: { issueId: 'ISS-1' },
      parent: { tenantSession: { sessionId: 'session-1' } },
    });
    await storage.close();
  });

  it('resumes a queued issue from SQLite after coordinator restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-durable-issue-'));
    roots.push(root);
    const filename = path.join(root, 'issues.sqlite');
    const firstStorage = await SqliteStorageV2.open({ filename });
    const first = new DurableIssueCoordinator({
      store: new SqliteDurableChildStore({
        store: firstStorage.checkpoints,
        tenantId: 'tenant-a',
      }),
      executor: async () => { throw new Error('first process must not execute'); },
    });
    await first.queue({
      childId: 'issue-child-restart',
      parentRunId: 'issue-parent-restart',
      agent: issueAgent,
      input: 'resume ISS-2',
      context: { issueId: 'ISS-2', sessionId: 'session-2' },
      sessionId: 'session-2',
      autoStart: false,
    });
    await firstStorage.close();

    const secondStorage = await SqliteStorageV2.open({ filename });
    const execute = vi.fn(async request => ({
      output: `resumed:${(request.context as { issueId: string }).issueId}` as JsonValue,
    }));
    const second = new DurableIssueCoordinator({
      store: new SqliteDurableChildStore({
        store: secondStorage.checkpoints,
        tenantId: 'tenant-a',
      }),
      executor: execute,
    }).registerAgent(issueAgent);

    await expect(second.resume('issue-child-restart')).resolves.toMatchObject({
      status: 'completed',
      output: 'resumed:ISS-2',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(await second.query('issue-child-restart')).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    await secondStorage.close();
  });
});
