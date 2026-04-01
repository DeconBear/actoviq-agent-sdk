import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { ActoviqSdkError } from '../errors.js';
import type {
  ActoviqWorkspaceInfo,
  CreateGitWorktreeWorkspaceOptions,
  CreateTempWorkspaceOptions,
  CreateWorkspaceOptions,
} from '../types.js';

const execFile = promisify(execFileCallback);

type WorkspaceDisposer = () => Promise<void>;

export class ActoviqWorkspace implements ActoviqWorkspaceInfo {
  readonly id: string;
  readonly kind: ActoviqWorkspaceInfo['kind'];
  readonly path: string;
  readonly metadata: Record<string, string>;

  private disposed = false;

  constructor(
    info: ActoviqWorkspaceInfo,
    private readonly disposer?: WorkspaceDisposer,
  ) {
    this.id = info.id;
    this.kind = info.kind;
    this.path = info.path;
    this.metadata = { ...info.metadata };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.disposer?.();
  }
}

export async function createWorkspace(options: CreateWorkspaceOptions): Promise<ActoviqWorkspace> {
  const workspacePath = path.resolve(options.path);

  if (options.copyFrom) {
    await copyIntoWorkspace(path.resolve(options.copyFrom), workspacePath);
  } else if (options.ensureExists !== false) {
    await mkdir(workspacePath, { recursive: true });
  }

  return new ActoviqWorkspace({
    id: randomUUID(),
    kind: 'directory',
    path: workspacePath,
    metadata: { ...(options.metadata ?? {}) },
  });
}

export async function createTempWorkspace(
  options: CreateTempWorkspaceOptions = {},
): Promise<ActoviqWorkspace> {
  const parentDir = path.resolve(options.parentDir ?? os.tmpdir());
  await mkdir(parentDir, { recursive: true });

  const workspacePath = await mkdtemp(path.join(parentDir, options.prefix ?? 'actoviq-workspace-'));
  if (options.copyFrom) {
    await copyIntoWorkspace(path.resolve(options.copyFrom), workspacePath);
  }

  return new ActoviqWorkspace(
    {
      id: randomUUID(),
      kind: 'temp',
      path: workspacePath,
      metadata: { ...(options.metadata ?? {}) },
    },
    async () => {
      await rm(workspacePath, { recursive: true, force: true });
    },
  );
}

export async function createGitWorktreeWorkspace(
  options: CreateGitWorktreeWorkspaceOptions,
): Promise<ActoviqWorkspace> {
  if (options.detach && options.branch) {
    throw new ActoviqSdkError('Cannot create a detached worktree and a named branch at the same time.');
  }

  const repositoryPath = path.resolve(options.repositoryPath);
  await execGit(['-C', repositoryPath, 'rev-parse', '--show-toplevel']);

  const targetPath = options.path
    ? path.resolve(options.path)
    : path.resolve(
        options.parentDir ?? os.tmpdir(),
        options.name ?? `actoviq-worktree-${randomUUID().slice(0, 8)}`,
      );

  await mkdir(path.dirname(targetPath), { recursive: true });

  if (options.force) {
    await rm(targetPath, { recursive: true, force: true });
  }

  const args = ['-C', repositoryPath, 'worktree', 'add'];
  if (options.force) {
    args.push('--force');
  }
  if (options.detach) {
    args.push('--detach');
  }
  if (options.branch) {
    args.push('-b', options.branch);
  }

  args.push(targetPath);
  if (options.ref) {
    args.push(options.ref);
  } else if (!options.branch) {
    args.push('HEAD');
  }

  await execGit(args);

  return new ActoviqWorkspace(
    {
      id: randomUUID(),
      kind: 'git-worktree',
      path: targetPath,
      metadata: {
        repositoryPath,
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
        ...(options.metadata ?? {}),
      },
    },
    async () => {
      try {
        await execGit(['-C', repositoryPath, 'worktree', 'remove', '--force', targetPath]);
      } catch {
        await rm(targetPath, { recursive: true, force: true });
      }
    },
  );
}

async function copyIntoWorkspace(sourcePath: string, workspacePath: string): Promise<void> {
  await mkdir(path.dirname(workspacePath), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await cp(sourcePath, workspacePath, { recursive: true, force: true });
}

async function execGit(args: string[]): Promise<void> {
  try {
    await execFile('git', args, { windowsHide: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActoviqSdkError(`Git worktree operation failed: ${message}`);
  }
}

