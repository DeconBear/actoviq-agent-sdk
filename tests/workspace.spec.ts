import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitWorktreeWorkspace,
  createTempWorkspace,
  createWorkspace,
} from '../src/index.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('workspace helpers', () => {
  it('creates a standard workspace and can seed it from an existing directory', async () => {
    const seedDir = await createTempDir('actoviq-workspace-seed-');
    const workspaceRoot = await createTempDir('actoviq-workspace-root-');
    const targetPath = path.join(workspaceRoot, 'seeded-workspace');

    await mkdir(path.join(seedDir, 'nested'), { recursive: true });
    await writeFile(path.join(seedDir, 'nested', 'hello.txt'), 'seed data', 'utf8');

    const workspace = await createWorkspace({
      path: targetPath,
      copyFrom: seedDir,
      metadata: { role: 'seeded' },
    });

    expect(workspace.kind).toBe('directory');
    expect(workspace.path).toBe(targetPath);
    expect(workspace.metadata.role).toBe('seeded');
    expect(await readFile(path.join(workspace.path, 'nested', 'hello.txt'), 'utf8')).toBe('seed data');
  });

  it('creates a temp workspace and removes it when disposed', async () => {
    const seedDir = await createTempDir('actoviq-temp-seed-');
    await writeFile(path.join(seedDir, 'seed.txt'), 'temp seed', 'utf8');

    const workspace = await createTempWorkspace({
      prefix: 'actoviq-temp-test-',
      copyFrom: seedDir,
      metadata: { source: 'temp-seed' },
    });

    expect(workspace.kind).toBe('temp');
    expect(await readFile(path.join(workspace.path, 'seed.txt'), 'utf8')).toBe('temp seed');

    const workspacePath = workspace.path;
    await workspace.dispose();

    await expect(readFile(path.join(workspacePath, 'seed.txt'), 'utf8')).rejects.toThrow();
  });

  it('creates and disposes a git worktree workspace', async () => {
    const repoDir = await createTempDir('actoviq-worktree-repo-');
    const worktreeParent = await createTempDir('actoviq-worktree-parent-');
    const worktreePath = path.join(worktreeParent, 'review-worktree');

    await execFile('git', ['init', '-b', 'main'], { cwd: repoDir, windowsHide: true });
    await execFile('git', ['config', 'user.name', 'Actoviq Tests'], { cwd: repoDir, windowsHide: true });
    await execFile('git', ['config', 'user.email', 'tests@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });

    await writeFile(path.join(repoDir, 'tracked.txt'), 'tracked content', 'utf8');
    await execFile('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
    await execFile('git', ['commit', '-m', 'seed commit'], { cwd: repoDir, windowsHide: true });

    const workspace = await createGitWorktreeWorkspace({
      repositoryPath: repoDir,
      path: worktreePath,
      ref: 'HEAD',
    });

    expect(workspace.kind).toBe('git-worktree');
    expect(workspace.metadata.repositoryPath).toBe(repoDir);
    expect(await readFile(path.join(workspace.path, 'tracked.txt'), 'utf8')).toBe('tracked content');

    const topLevel = await execFile('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspace.path,
      windowsHide: true,
    });
    const [gitTopLevel, expectedTopLevel] = await Promise.all([
      realpath(topLevel.stdout.trim()),
      realpath(worktreePath),
    ]);
    expect(path.normalize(gitTopLevel)).toBe(path.normalize(expectedTopLevel));

    await workspace.dispose();

    await expect(readFile(path.join(worktreePath, 'tracked.txt'), 'utf8')).rejects.toThrow();
  });
});
