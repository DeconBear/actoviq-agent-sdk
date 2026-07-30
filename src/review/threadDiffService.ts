import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  DiffApplyResult,
  ThreadDiff,
  ThreadDiffFile,
} from './types.js';

const execFile = promisify(execFileCallback);

export class ThreadDiffService {
  async compute(input: {
    sessionId: string;
    repoRoot: string;
    worktreePath: string;
    baseCommit: string;
  }): Promise<ThreadDiff> {
    const [head, patch] = await Promise.all([
      this.git(['-C', input.worktreePath, 'rev-parse', 'HEAD']),
      this.git(['-C', input.worktreePath, 'diff', '--binary', '--no-color', input.baseCommit]),
    ]);
    return {
      sessionId: input.sessionId,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      baseCommit: input.baseCommit,
      headCommit: head.stdout.trim(),
      files: parseDiffFiles(patch.stdout),
      patch: patch.stdout,
      generatedAt: new Date().toISOString(),
    };
  }

  async apply(diff: ThreadDiff, targetDir: string): Promise<DiffApplyResult> {
    if (!diff.patch.trim()) {
      return { applied: true, conflict: false, message: 'No changes to apply.' };
    }
    const status = (await this.git(['-C', targetDir, 'status', '--porcelain'])).stdout.trim();
    if (status) {
      return {
        applied: false,
        conflict: true,
        message: 'Target working tree is dirty; apply was not attempted.',
      };
    }
    const result = await runGitWithInput(
      ['-C', targetDir, 'apply', '--3way', '--whitespace=nowarn', '-'],
      diff.patch,
    );
    return result.exitCode === 0
      ? { applied: true, conflict: false, message: 'Diff applied to target working tree.' }
      : {
          applied: false,
          conflict: true,
          message: result.stderr || 'git apply reported a conflict.',
        };
  }

  async checkout(input: {
    targetDir: string;
    branch: string;
  }): Promise<DiffApplyResult> {
    const status = (await this.git(['-C', input.targetDir, 'status', '--porcelain'])).stdout.trim();
    if (status) {
      return {
        applied: false,
        conflict: true,
        message: 'Target working tree is dirty; checkout was not attempted.',
      };
    }
    try {
      await this.git(['-C', input.targetDir, 'switch', input.branch]);
      return { applied: true, conflict: false, message: `Checked out ${input.branch}.` };
    } catch (error) {
      return {
        applied: false,
        conflict: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
  }
}

function parseDiffFiles(patch: string): ThreadDiffFile[] {
  const starts = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? patch.length;
    const block = patch.slice(start, end);
    const oldPath = match[1]!;
    const filePath = match[2]!;
    const additions = [...block.matchAll(/^\+(?!\+\+)/gmu)].length;
    const deletions = [...block.matchAll(/^-(?!--)/gmu)].length;
    const status: ThreadDiffFile['status'] = block.includes('new file mode')
      ? 'added'
      : block.includes('deleted file mode')
        ? 'deleted'
        : block.includes('rename from ')
          ? 'renamed'
          : 'modified';
    return {
      path: filePath,
      ...(oldPath !== filePath ? { oldPath } : {}),
      status,
      additions,
      deletions,
      patch: block,
    };
  });
}

function runGitWithInput(
  args: string[],
  input: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', code => resolve({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
    }));
    child.stdin.end(input);
  });
}
