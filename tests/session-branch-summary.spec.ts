import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore, summarizeSessionBranch } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('summarizeSessionBranch', () => {
  it('returns branch identity and transcript preview', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-branch-summary-'));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const session = await store.create({
      title: 'Branch',
      model: 'test',
      parentSessionId: 'parent',
      parentMessageId: 'msg-parent',
      branchName: 'Experiment',
      initialMessages: [{ role: 'user', content: 'try this path' }],
    });
    await expect(summarizeSessionBranch(store, session.id)).resolves.toMatchObject({
      parentSessionId: 'parent',
      parentMessageId: 'msg-parent',
      branchName: 'Experiment',
      preview: expect.stringContaining('try this path'),
    });
  });
});
