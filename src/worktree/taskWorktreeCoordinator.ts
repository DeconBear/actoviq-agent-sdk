import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';

const execFile = promisify(execFileCallback);

export interface TaskWorktreeLocator {
  version: 1;
  revision: number;
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
}

export class TaskWorktreeCoordinator {
  private readonly repoRoot: string;
  private readonly storageRoot: string;
  private readonly worktreesRoot: string;

  constructor(options: {
    repoRoot: string;
    storageRoot: string;
    worktreesRoot?: string;
  }) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.storageRoot = path.resolve(options.storageRoot);
    this.worktreesRoot = path.resolve(
      options.worktreesRoot
        ?? path.join(path.dirname(this.repoRoot), '.hadamard-worktrees', path.basename(this.repoRoot)),
    );
  }

  async createOrResume(
    sessionId: string,
    options: { baseRef?: string; branch?: string } = {},
  ): Promise<TaskWorktreeLocator> {
    const existing = await this.read(sessionId);
    if (existing) {
      const valid = await this.git(['-C', existing.worktreePath, 'rev-parse', '--is-inside-work-tree'])
        .then(result => result.stdout.trim() === 'true', () => false);
      if (valid) return existing;
      throw new Error(`Recorded worktree is missing or invalid: ${existing.worktreePath}`);
    }
    const safeId = assertSafeStorageSegment('sessionId', sessionId);
    const worktreePath = path.join(this.worktreesRoot, safeId);
    const branch = options.branch?.trim() || `hadamard/${safeId}`;
    const baseRef = options.baseRef?.trim() || 'HEAD';
    const baseCommit = (await this.git(['-C', this.repoRoot, 'rev-parse', baseRef])).stdout.trim();
    await mkdir(path.dirname(worktreePath), { recursive: true });
    let added = false;
    try {
      await this.git([
        '-C', this.repoRoot,
        'worktree', 'add',
        '-b', branch,
        worktreePath,
        baseCommit,
      ]);
      added = true;
      const timestamp = new Date().toISOString();
      const locator: TaskWorktreeLocator = {
        version: 1,
        revision: 0,
        sessionId: safeId,
        repoRoot: this.repoRoot,
        worktreePath,
        branch,
        baseCommit,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.write(locator);
      return structuredClone(locator);
    } catch (error) {
      if (added) {
        await this.git([
          '-C', this.repoRoot,
          'worktree', 'remove', '--force', worktreePath,
        ]).catch(() => undefined);
        await this.git([
          '-C', this.repoRoot,
          'branch', '-D', branch,
        ]).catch(() => undefined);
      }
      throw error;
    }
  }

  async read(sessionId: string): Promise<TaskWorktreeLocator | null> {
    try {
      return JSON.parse(await readFile(this.locatorPath(sessionId), 'utf8')) as TaskWorktreeLocator;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async cleanup(sessionId: string, options: { force?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    const locator = await this.read(sessionId);
    if (!locator) return;
    const dirty = (await this.git([
      '-C', locator.worktreePath,
      'status', '--porcelain',
    ])).stdout.trim().length > 0;
    if (dirty && !options.force) {
      throw new Error('Worktree has uncommitted changes; cleanup requires force confirmation.');
    }
    await this.git([
      '-C', this.repoRoot,
      'worktree', 'remove',
      ...(options.force ? ['--force'] : []),
      locator.worktreePath,
    ]);
    if (options.deleteBranch) {
      await this.git(['-C', this.repoRoot, 'branch', '-D', locator.branch]);
    }
    await rm(this.locatorPath(sessionId), { force: true });
  }

  private async write(locator: TaskWorktreeLocator): Promise<void> {
    const file = this.locatorPath(locator.sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, locator);
  }

  private locatorPath(sessionId: string): string {
    return path.join(
      this.storageRoot,
      `${assertSafeStorageSegment('sessionId', sessionId)}.json`,
    );
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
  }
}
