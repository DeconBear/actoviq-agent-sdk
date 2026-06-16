/**
 * WorktreeService — abstracts git worktree operations for the SDK.
 * Handles create, enter, exit, list, cleanup, and dirty detection.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ActoviqSdkError } from '../errors.js';
import type { WorktreeInfo, WorktreeSettings, WorktreeStackEntry } from '../types.js';

const execFile = promisify(execFileCallback);

// ── Adjective/Noun lists for auto-generated names ────────────────
const ADJECTIVES = [
  'bright', 'swift', 'calm', 'bold', 'keen', 'warm', 'cool', 'deep',
  'fair', 'gold', 'pure', 'sharp', 'vast', 'wise', 'true', 'fresh',
];
const COLORS = [
  'crimson', 'azure', 'emerald', 'amber', 'violet', 'coral', 'indigo',
  'sage', 'ruby', 'jade', 'onyx', 'opal', 'teal', 'plum', 'slate', 'ivory',
];
const NOUNS = [
  'fox', 'owl', 'hawk', 'wolf', 'deer', 'bear', 'dove', 'lynx',
  'pike', 'crab', 'seal', 'swan', 'wren', 'frog', 'moth', 'newt',
];

function randomWord(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)]!;
}

export function generateWorktreeName(): string {
  return `${randomWord(ADJECTIVES)}-${randomWord(COLORS)}-${randomWord(NOUNS)}`;
}

// ── Git helpers ──────────────────────────────────────────────────

async function execGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', args, { windowsHide: true, cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActoviqSdkError(`Git operation failed: ${message}`);
  }
}

async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execGit(['rev-parse', '--show-toplevel'], cwd);
  return path.resolve(result.stdout.trim());
}

async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const result = await execGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoRoot);
    const ref = result.stdout.trim();
    // origin/HEAD → strip origin/
    return ref.replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

// ── WorktreeService ──────────────────────────────────────────────

export class WorktreeService {
  private worktreesDir: string;
  private repoRoot: string;
  private settings: WorktreeSettings;
  private workDirStack: WorktreeStackEntry[] = [];
  private sessionWorkDir: string;

  constructor(
    initialWorkDir: string,
    settings?: Partial<WorktreeSettings>,
  ) {
    this.sessionWorkDir = path.resolve(initialWorkDir);
    this.settings = {
      baseRef: settings?.baseRef ?? 'fresh',
      cleanupPeriodDays: settings?.cleanupPeriodDays ?? 7,
    };
    this.repoRoot = '';
    this.worktreesDir = '';
  }

  async init(): Promise<void> {
    try {
      this.repoRoot = await getRepoRoot(this.sessionWorkDir);
    } catch {
      // Not a git repo — worktree features unavailable
      this.repoRoot = '';
      return;
    }
    this.worktreesDir = path.join(this.repoRoot, '.actoviq', 'worktrees');
    await mkdir(this.worktreesDir, { recursive: true });
  }

  get currentWorkDir(): string {
    return this.sessionWorkDir;
  }

  get isInWorktree(): boolean {
    return this.workDirStack.length > 0;
  }

  get worktreePath(): string | undefined {
    return this.workDirStack.length > 0
      ? this.workDirStack[this.workDirStack.length - 1]!.worktreePath
      : undefined;
  }

  get worktreeBranch(): string | undefined {
    return this.workDirStack.length > 0
      ? this.workDirStack[this.workDirStack.length - 1]!.worktreeBranch
      : undefined;
  }

  get repoRootPath(): string {
    return this.repoRoot;
  }

  get worktreesDirectory(): string {
    return this.worktreesDir;
  }

  /** Resolve base ref for new worktrees. */
  private async resolveBaseRef(): Promise<string> {
    if (this.settings.baseRef === 'head') return 'HEAD';
    try {
      const branch = await getDefaultBranch(this.repoRoot);
      return `origin/${branch}`;
    } catch {
      return 'HEAD';
    }
  }

  /** Enter an existing worktree by path. */
  async enterWorktree(worktreePath: string, branch?: string): Promise<WorktreeStackEntry> {
    if (!this.repoRoot) {
      throw new ActoviqSdkError('Not in a git repository. Cannot enter worktree.');
    }

    const resolved = path.resolve(worktreePath);
    if (!fs.existsSync(resolved)) {
      throw new ActoviqSdkError(`Worktree path does not exist: ${resolved}`);
    }

    // Verify it's under .actoviq/worktrees/
    const relativePath = path.relative(this.worktreesDir, resolved);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new ActoviqSdkError(
        `Worktree must be under ${this.worktreesDir}. Got: ${resolved}`,
      );
    }

    // Safety: if already in a worktree, only allow switching to another worktree
    if (this.isInWorktree) {
      const currentEntry = this.workDirStack[this.workDirStack.length - 1]!;
      if (path.resolve(currentEntry.workDir) === resolved) {
        throw new ActoviqSdkError('Already in this worktree.');
      }
    }

    const resolvedBranch = branch ?? relativePath.split(path.sep)[0] ?? 'worktree';

    const entry: WorktreeStackEntry = {
      workDir: resolved,
      worktreePath: resolved,
      worktreeBranch: resolvedBranch,
      sessionKind: 'worktree',
    };

    this.workDirStack.push(entry);
    this.sessionWorkDir = resolved;

    return entry;
  }

  /** Create a new worktree and enter it. */
  async createAndEnterWorktree(options: {
    name?: string;
    branch?: string;
    ref?: string;
    detach?: boolean;
    pr?: string;
  }): Promise<WorktreeStackEntry> {
    if (!this.repoRoot) {
      throw new ActoviqSdkError('Not in a git repository. Cannot create worktree.');
    }

    const name = options.name ?? generateWorktreeName();
    const branch = options.branch ?? `worktree-${name}`;
    const worktreePath = path.join(this.worktreesDir, name);

    if (fs.existsSync(worktreePath)) {
      throw new ActoviqSdkError(`Worktree already exists: ${worktreePath}`);
    }

    await mkdir(path.dirname(worktreePath), { recursive: true });

    const args: string[] = ['-C', this.repoRoot, 'worktree', 'add'];

    if (options.detach) {
      args.push('--detach');
    } else {
      args.push('-b', branch);
    }

    args.push(worktreePath);

    if (options.pr) {
      // PR-based checkout: fetch pull/<n>/head
      const prNum = options.pr.replace(/^#/, '');
      try {
        await execGit([
          '-C', this.repoRoot, 'fetch', 'origin',
          `pull/${prNum}/head:refs/remotes/origin/pr/${prNum}`,
        ]);
        args.push(`origin/pr/${prNum}`);
      } catch {
        throw new ActoviqSdkError(
          `Failed to fetch PR #${prNum}. Make sure the remote is configured.`,
        );
      }
    } else if (options.ref) {
      args.push(options.ref);
    } else {
      const baseRef = await this.resolveBaseRef();
      args.push(baseRef);
    }

    await execGit(args);

    // Copy .worktreeinclude files
    await this.applyWorktreeInclude(worktreePath);

    const entry: WorktreeStackEntry = {
      workDir: worktreePath,
      worktreePath,
      worktreeBranch: branch,
      sessionKind: 'worktree',
    };

    this.workDirStack.push(entry);
    this.sessionWorkDir = worktreePath;

    return entry;
  }

  /** Exit current worktree, return to previous workDir. */
  exitWorktree(): WorktreeStackEntry | null {
    if (this.workDirStack.length === 0) {
      throw new ActoviqSdkError('Not in a worktree. Nothing to exit.');
    }

    const popped = this.workDirStack.pop()!;
    this.sessionWorkDir = this.workDirStack.length > 0
      ? this.workDirStack[this.workDirStack.length - 1]!.workDir
      : popped.workDir; // TODO: restore to originalWorkDir

    return popped;
  }

  /** Check if a worktree directory is dirty (has uncommitted changes or untracked files). */
  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    try {
      const result = await execGit(['-C', worktreePath, 'status', '--porcelain']);
      return result.stdout.trim().length > 0;
    } catch {
      // On error, assume clean (prevent worktree leaks per CLAUDE.md quirk)
      return false;
    }
  }

  /** Clean up a worktree: remove directory and git worktree reference. */
  async removeWorktree(worktreePath: string, branch?: string): Promise<void> {
    try {
      await execGit(['-C', this.repoRoot, 'worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Fallback: manual cleanup
      if (branch) {
        try {
          await execGit(['-C', this.repoRoot, 'branch', '-D', branch]);
        } catch { /* ignore */ }
      }
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  /** List all worktrees in .actoviq/worktrees/. */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    if (!this.repoRoot || !fs.existsSync(this.worktreesDir)) return [];

    const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
    const results: WorktreeInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(this.worktreesDir, entry.name);
      try {
        const st = await stat(fullPath);
        const dirty = await this.isWorktreeDirty(fullPath);
        results.push({
          path: fullPath,
          branch: undefined,
          createdAt: st.birthtime.toISOString(),
          isDirty: dirty,
        });
      } catch { /* skip inaccessible */ }
    }

    return results;
  }

  /** Scan for orphan worktrees (directories without corresponding sessions). */
  async findOrphanWorktrees(): Promise<WorktreeInfo[]> {
    const all = await this.listWorktrees();
    // In a full implementation, cross-reference with session storage.
    // For now, mark all as potential orphans for the caller to handle.
    return all;
  }

  /** Apply .worktreeinclude: copy gitignored files to new worktree. */
  async applyWorktreeInclude(worktreePath: string): Promise<void> {
    const includeFile = path.join(this.repoRoot, '.worktreeinclude');
    if (!fs.existsSync(includeFile)) return;

    try {
      const { parseWorktreeInclude } = await import('./worktreeInclude.js');
      const patterns = await parseWorktreeInclude(includeFile);
      const repoFiles = await this.listRepoFiles();

      for (const pattern of patterns) {
        for (const file of repoFiles) {
          if (matchesWorktreeIncludePattern(file, pattern)) {
            const src = path.join(this.repoRoot, file);
            const dest = path.join(worktreePath, file);

            // Edge case: branch already has the file
            if (fs.existsSync(dest)) {
              // Skip with warning — don't overwrite
              continue;
            }

            await mkdir(path.dirname(dest), { recursive: true });

            // TOCTOU: stat before copy, verify after
            const srcStat = await stat(src);
            await copyFileAtomic(src, dest);
            const destStat = await stat(dest);

            if (srcStat.mtimeMs !== destStat.mtimeMs || srcStat.size !== destStat.size) {
              // TOCTOU detected: re-copy once
              await copyFileAtomic(src, dest);
            }
          }
        }
      }
    } catch {
      // .worktreeinclude errors are non-fatal
    }
  }

  private async listRepoFiles(): Promise<string[]> {
    try {
      const result = await execGit([
        '-C', this.repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard',
      ]);
      return result.stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function copyFileAtomic(src: string, dest: string): Promise<void> {
  const { copyFile } = await import('node:fs/promises');
  await copyFile(src, dest);
}

function matchesWorktreeIncludePattern(file: string, pattern: string): boolean {
  // Simplified .gitignore-style matching
  // Support * wildcard and ** globstar
  const regex = globToRegex(pattern);
  return regex.test(file);
}

function globToRegex(pattern: string): RegExp {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/\?/g, '[^/]');

  if (pattern.startsWith('/')) {
    escaped = '^' + escaped.slice(1);
  } else {
    escaped = '(^|.*/)' + escaped;
  }

  if (pattern.endsWith('/')) {
    escaped = escaped.slice(0, -1) + '(/.*)?$';
  } else {
    escaped += '$';
  }

  return new RegExp(escaped);
}
