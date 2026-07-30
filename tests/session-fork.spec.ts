import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionForkService, SessionGraph, SessionStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('SessionForkService', () => {
  it('forks at an arbitrary stable message without mutating the source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-session-fork-'));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const source = await store.create({
      title: 'Source',
      model: 'test',
      initialMessages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
    });
    const refs = await new SessionGraph(store).ensureMessageIds(source.id);
    const fork = await new SessionForkService(store).forkAtMessage(
      source.id,
      refs[1]!.id,
      { branchName: 'Alternative' },
    );

    expect(fork.messages).toHaveLength(2);
    expect(fork.parentSessionId).toBe(source.id);
    expect(fork.parentMessageId).toBe(refs[1]!.id);
    expect(fork.branchName).toBe('Alternative');
    expect((await store.load(source.id)).messages).toHaveLength(3);
  });

  it('demotes worktree Sessions so forks do not inherit the parent worktree cwd', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-session-fork-wt-'));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const source = await store.create({
      title: 'Worktree Source',
      model: 'test',
      kind: 'worktree',
      originalWorkDir: path.join(dir, 'repo'),
      metadata: { __actoviqWorkDir: path.join(dir, 'worktree-a') },
      initialMessages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    });
    // Persist worktreePath outside create options (store field).
    await store.mutate(source.id, current => ({
      ...current,
      worktreePath: path.join(dir, 'worktree-a'),
      worktreeBranch: 'task/demo',
    }));
    const refs = await new SessionGraph(store).ensureMessageIds(source.id);
    const fork = await new SessionForkService(store).forkAtMessage(source.id, refs[0]!.id);

    expect(fork.kind).toBe('main');
    expect(fork.worktreePath).toBeUndefined();
    expect(fork.metadata.__actoviqWorkDir).toBe(path.join(dir, 'repo'));
  });
});
