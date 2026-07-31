import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionGraph, SessionStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('SessionGraph', () => {
  it('assigns stable legacy message ids and builds parent/child trees', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-session-graph-'));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const parent = await store.create({
      model: 'test',
      initialMessages: [{ role: 'user', content: 'root' }],
    });
    const child = await store.create({
      model: 'test',
      parentSessionId: parent.id,
      initialMessages: [{ role: 'user', content: 'child' }],
    });
    const graph = new SessionGraph(store);
    const first = await graph.ensureMessageIds(parent.id);
    const second = await graph.ensureMessageIds(parent.id);
    const roots = await graph.roots();

    expect(first[0]?.id).toBe(second[0]?.id);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.children[0]?.session.id).toBe(child.id);
  });
});
