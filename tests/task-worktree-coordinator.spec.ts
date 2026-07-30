import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskWorktreeCoordinator } from '../src/worktree/taskWorktreeCoordinator.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-task-worktree-'));
  tempDirs.push(root);
  await execFile('git', ['init', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'file.txt'), 'base');
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

describe('TaskWorktreeCoordinator', () => {
  it('creates idempotent Session-owned worktrees and protects dirty cleanup', async () => {
    const root = await repository();
    const coordinator = new TaskWorktreeCoordinator({
      repoRoot: root,
      storageRoot: path.join(root, '.local-state'),
      worktreesRoot: path.join(path.dirname(root), `${path.basename(root)}-worktrees`),
    });
    const first = await coordinator.createOrResume('session-1');
    const second = await coordinator.createOrResume('session-1');
    expect(second).toEqual(first);

    await writeFile(path.join(first.worktreePath, 'file.txt'), 'changed');
    await expect(coordinator.cleanup('session-1')).rejects.toThrow('uncommitted changes');
    await coordinator.cleanup('session-1', { force: true, deleteBranch: true });
    await expect(coordinator.read('session-1')).resolves.toBeNull();
  });

  it('removes the worktree and branch when locator persistence fails', async () => {
    const root = await repository();
    const blockedStorage = path.join(root, 'blocked-storage');
    const worktreesRoot = path.join(path.dirname(root), `${path.basename(root)}-rollback`);
    await writeFile(blockedStorage, 'not a directory');
    const coordinator = new TaskWorktreeCoordinator({
      repoRoot: root,
      storageRoot: blockedStorage,
      worktreesRoot,
    });

    await expect(coordinator.createOrResume('session-rollback')).rejects.toThrow();
    const worktrees = await execFile('git', ['-C', root, 'worktree', 'list', '--porcelain']);
    expect(worktrees.stdout).not.toContain(path.join(worktreesRoot, 'session-rollback'));
    await expect(execFile('git', [
      '-C', root,
      'show-ref', '--verify', 'refs/heads/actoviq/session-rollback',
    ])).rejects.toThrow();
  });
});
