import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSdk, type ModelApi } from '../src/index.js';

const execFile = promisify(execFileCallback);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('automatic Session worktrees', () => {
  it('creates and resumes a Session-owned worktree and exposes its diff', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'actoviq-auto-worktree-'));
    dirs.push(base);
    const repo = path.join(base, 'repo');
    await execFile('git', ['init', repo]);
    await execFile('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await execFile('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'file.txt'), 'base\n');
    await execFile('git', ['-C', repo, 'add', '.']);
    await execFile('git', ['-C', repo, 'commit', '-m', 'base']);
    const modelApi = {
      createMessage: async () => { throw new Error('Unexpected model call.'); },
      streamMessage: () => { throw new Error('Unexpected model call.'); },
    } as unknown as ModelApi;
    const sdk = await createAgentSdk({
      model: 'test',
      modelApi,
      workDir: repo,
      sessionDirectory: path.join(base, 'sessions'),
      autoWorktree: true,
    });
    let sessionId = '';
    try {
      const session = await sdk.createSession();
      sessionId = session.id;
      const snapshot = session.snapshot();
      expect(snapshot.kind).toBe('worktree');
      expect(snapshot.worktreePath).toBeTruthy();
      await writeFile(path.join(snapshot.worktreePath!, 'file.txt'), 'base\nchanged\n');
      const diff = await sdk.getSessionDiff(session.id);
      expect(diff.files[0]).toMatchObject({ path: 'file.txt', additions: 1 });
      expect((await sdk.resumeSession(session.id)).snapshot().worktreePath).toBe(snapshot.worktreePath);
    } finally {
      if (sessionId) {
        await sdk.taskWorktrees?.cleanup(sessionId, { force: true, deleteBranch: true });
      }
      await sdk.close();
    }
  });
});
