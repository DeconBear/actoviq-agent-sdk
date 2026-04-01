import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-store-'));
  tempDirs.push(dir);
  return new SessionStore(dir);
}

describe('SessionStore', () => {
  it('creates, lists, loads, forks, and deletes sessions', async () => {
    const store = await createStore();

    const created = await store.create({
      title: 'Alpha',
      model: 'demo-model',
      initialMessages: [{ role: 'user', content: 'hello world' }],
    });

    created.runs.push({
      runId: 'run-1',
      input: 'hello world',
      text: 'hi there',
      stopReason: 'end_turn',
      createdAt: created.createdAt,
      completedAt: created.createdAt,
      toolCallCount: 0,
    });
    created.lastRunAt = created.createdAt;
    await store.save(created);

    const loaded = await store.load(created.id);
    const listed = await store.list();
    const forked = await store.fork(created.id, { title: 'Alpha Copy' });

    expect(loaded.title).toBe('Alpha');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.preview).toContain('hello world');
    expect(forked.title).toBe('Alpha Copy');
    expect(forked.runs).toHaveLength(0);

    await store.delete(created.id);

    const listedAfterDelete = await store.list();
    expect(listedAfterDelete.map((item) => item.id)).toContain(forked.id);
    expect(listedAfterDelete.map((item) => item.id)).not.toContain(created.id);
  });
});
