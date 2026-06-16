/**
 * WorktreeCreate / WorktreeRemove hooks for non-git VCS support.
 * Hooks receive JSON on stdin and output the result directory path on stdout.
 */
import { spawn } from 'node:child_process';
import type { ActoviqHooks } from '../types.js';

export interface WorktreeCreateHookInput {
  name: string;
  repositoryPath: string;
}

export interface WorktreeRemoveHookInput {
  name: string;
  path: string;
  repositoryPath: string;
}

export interface WorktreeHookResult {
  path: string;
  metadata?: Record<string, string>;
}

function spawnWithInput(command: string, args: string[], stdinData: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`Hook command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        reject(new Error(`Hook command "${command}" exited with code ${code}. Stderr: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write stdin and close it
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Execute a WorktreeCreate hook command.
 * The hook receives JSON { name } on stdin and must output the directory path on stdout.
 */
export async function executeWorktreeCreateHook(
  command: string,
  input: WorktreeCreateHookInput,
): Promise<WorktreeHookResult> {
  const { stdout, stderr } = await spawnWithInput(
    command,
    [],
    JSON.stringify({ name: input.name }),
  );

  const hookPath = stdout.trim();
  if (!hookPath) {
    throw new Error(`WorktreeCreate hook "${command}" returned no path. Stderr: ${stderr}`);
  }

  return { path: hookPath };
}

/**
 * Execute a WorktreeRemove hook command.
 * The hook receives JSON { name, path } on stdin.
 */
export async function executeWorktreeRemoveHook(
  command: string,
  input: WorktreeRemoveHookInput,
): Promise<void> {
  await spawnWithInput(
    command,
    [],
    JSON.stringify({ name: input.name, path: input.path }),
  );
}

/**
 * Resolve worktree hooks from ActoviqHooks configuration.
 * Returns the hook commands if configured.
 */
export function resolveWorktreeHooks(
  hooks?: ActoviqHooks,
): { create?: string; remove?: string } {
  const metadata = (hooks as any)?.metadata as Record<string, unknown> | undefined;
  return {
    create: (metadata?.worktreeCreateHook as string) ?? process.env.ACTOVIQ_WORKTREE_CREATE_HOOK ?? undefined,
    remove: (metadata?.worktreeRemoveHook as string) ?? process.env.ACTOVIQ_WORKTREE_REMOVE_HOOK ?? undefined,
  };
}

/**
 * Check if hooks are configured (meaning .worktreeinclude should be skipped
 * since the hook is responsible for file setup).
 */
export function hasWorktreeHooks(hooks?: ActoviqHooks): boolean {
  const resolved = resolveWorktreeHooks(hooks);
  return !!(resolved.create || resolved.remove);
}
