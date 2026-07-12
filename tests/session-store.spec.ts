import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionConflictError,
  SessionDataError,
  SessionStore,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-store-'));
  tempDirs.push(dir);
  return new SessionStore(dir);
}

async function createStoreAndRoot(): Promise<{ store: SessionStore; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-store-'));
  tempDirs.push(root);
  return { store: new SessionStore(root), root };
}

describe('SessionStore', () => {
  it('creates, lists, loads, forks, and deletes sessions', async () => {
    const store = await createStore();

    const created = await store.create({
      title: 'Alpha',
      model: 'demo-model',
      initialMessages: [{ role: 'user', content: 'hello world' }],
    });
    expect(created.revision).toBe(1);

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
    expect(created.revision).toBe(2);

    const loaded = await store.load(created.id);
    const listed = await store.list();
    const forked = await store.fork(created.id, { title: 'Alpha Copy' });

    expect(loaded.title).toBe('Alpha');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.preview).toContain('hello world');
    expect(listed[0]?.runtime).toBe('hadamard');
    expect(listed[0]?.configName).toBeNull();

    created.metadata.__actoviqRuntime = 'claude';
    created.metadata.__actoviqConfigName = 'deepseek';
    created.metadata.__actoviqIssueId = 'iss_1';
    created.metadata.__actoviqIssueNumber = 1;
    created.metadata.__actoviqIssueKey = 'ISS-1';
    created.metadata.__actoviqAgentProfile = 'Claude reviewer';
    await store.save(created);
    const relisted = await store.list();
    const updated = relisted.find((item) => item.id === created.id);
    expect(updated?.runtime).toBe('claude');
    expect(updated?.configName).toBe('deepseek');
    expect(updated?.issueId).toBe('iss_1');
    expect(updated?.issueNumber).toBe(1);
    expect(updated?.issueKey).toBe('ISS-1');
    expect(updated?.agentProfile).toBe('Claude reviewer');
    expect(forked.title).toBe('Alpha Copy');
    expect(forked.runs).toHaveLength(0);

    await store.delete(created.id);

    const listedAfterDelete = await store.list();
    expect(listedAfterDelete.map((item) => item.id)).toContain(forked.id);
    expect(listedAfterDelete.map((item) => item.id)).not.toContain(created.id);
  });

  it('rejects a stale revision instead of silently overwriting a newer session', async () => {
    const store = await createStore();
    const created = await store.create({ title: 'CAS', model: 'demo-model' });
    const first = await store.load(created.id);
    const stale = await store.load(created.id);

    first.title = 'first writer';
    await store.save(first);
    stale.title = 'stale writer';

    await expect(store.save(stale)).rejects.toMatchObject({
      code: 'SESSION_CONFLICT',
      sessionId: created.id,
      expectedRevision: 1,
      actualRevision: 2,
    } satisfies Partial<SessionConflictError>);
    await expect(store.load(created.id)).resolves.toMatchObject({
      title: 'first writer',
      revision: 2,
    });
  });

  it('serializes cross-instance writers and allows exactly one CAS commit', async () => {
    const { store, root } = await createStoreAndRoot();
    const otherStore = new SessionStore(root);
    const created = await store.create({ title: 'Shared', model: 'demo-model' });
    const left = await store.load(created.id);
    const right = await otherStore.load(created.id);
    left.title = 'left';
    right.title = 'right';

    const results = await Promise.allSettled([store.save(left), otherStore.save(right)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'SESSION_CONFLICT' }),
    });
    expect((await store.load(created.id)).revision).toBe(2);
  });

  it('loads a legacy v1 snapshot at revision zero and migrates it on save', async () => {
    const { store, root } = await createStoreAndRoot();
    const created = await store.create({ id: 'legacy', title: 'Legacy', model: 'demo-model' });
    const filePath = path.join(root, 'sessions', 'legacy.json');
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    delete raw.revision;
    await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const legacy = await store.load(created.id);
    expect(legacy.revision).toBe(0);
    legacy.title = 'Migrated';
    await store.save(legacy);
    expect(legacy.revision).toBe(1);
    await expect(store.load(created.id)).resolves.toMatchObject({
      title: 'Migrated',
      revision: 1,
    });
  });

  it('rejects malformed session shapes with a stable data error', async () => {
    const { store, root } = await createStoreAndRoot();
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    await writeFile(
      path.join(root, 'sessions', 'broken.json'),
      JSON.stringify({ version: 1, id: 'broken', messages: 'not-an-array' }),
      'utf8',
    );

    await expect(store.load('broken')).rejects.toBeInstanceOf(SessionDataError);
    await expect(store.load('broken')).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });
    await expect(store.list()).resolves.toEqual([]);
  });
});
