/**
 * User-configurable PreToolUse hooks (gap #2, scoped subset).
 *
 * Claude Code lets users gate tools behind shell commands in settings.json.
 * This module provides a `createPreToolUseHookClassifier()` that loads a
 * `hooks.PreToolUse[]` block from the Actoviq settings store and runs each
 * matching command before a tool executes. A command that exits non-zero (or
 * prints a line starting with "BLOCK") denies the tool; a zero exit allows it.
 *
 * The classifier is the engine's PreToolUse seam (actoviqPermissions.ts), so
 * this needs no engine changes — the TUI/SDK wires it via `classifier` in the
 * run options. Hooks are best-effort and never throw (a failing hook command
 * denies with the captured stderr, not a crash).
 */
import { spawnSync } from 'node:child_process';

import type { ActoviqToolClassifier, ActoviqClassifierOutcome } from '../types.js';

export interface PreToolUseHook {
  /** Glob-style matcher for the tool name, e.g. "Bash", "Write", "Edit", "*". */
  matcher: string;
  /** Shell command run before the tool. $TOOL and $INPUT env vars are set. */
  command: string;
  /** Optional human-readable label for the /hooks list. */
  description?: string;
}

/** Read the hooks block from a settings object (already loaded JSON). */
export function readPreToolUseHooks(raw: unknown): PreToolUseHook[] {
  const hooks = (raw as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(hooks)) return [];
  return hooks
    .filter((h): h is PreToolUseHook =>
      typeof h === 'object' && h !== null &&
      typeof (h as PreToolUseHook).matcher === 'string' &&
      typeof (h as PreToolUseHook).command === 'string')
    .map(h => ({
      matcher: h.matcher,
      command: h.command,
      ...(h.description ? { description: h.description } : {}),
    }));
}

function toolMatches(matcher: string, toolName: string): boolean {
  if (matcher === '*' || matcher === '') return true;
  // Simple glob: "*" wildcard segments.
  const re = new RegExp(
    '^' + matcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i',
  );
  return re.test(toolName);
}

/**
 * Build a PreToolUse classifier. `loadHooks` is a function that returns the
 * current hook list (so settings edits are picked up without rebuilding) —
 * typically `() => readPreToolUseHooks(getLoadedJsonConfig())`.
 */
export function createPreToolUseHookClassifier(
  loadHooks: () => PreToolUseHook[],
): ActoviqToolClassifier {
  return async (ctx): Promise<ActoviqClassifierOutcome | void> => {
    const hooks = loadHooks();
    if (hooks.length === 0) return undefined;
    const matched = hooks.filter(h => toolMatches(h.matcher, ctx.publicName));
    if (matched.length === 0) return undefined;
    for (const hook of matched) {
      let blocked = false;
      let reason = '';
      try {
        const result = spawnSync(hook.command, {
          shell: true,
          cwd: ctx.workDir,
          input: '',
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            ACTOVIQ_HOOK_EVENT: 'PreToolUse',
            ACTOVIQ_HOOK_TOOL: ctx.publicName,
            ACTOVIQ_HOOK_INPUT: (() => { try { return JSON.stringify(ctx.input ?? {}); } catch { return '{}'; } })(),
            ACTOVIQ_HOOK_PROMPT: typeof ctx.prompt === 'string' ? ctx.prompt.slice(0, 4000) : '',
          },
        });
        const stdout = (result.stdout ?? '').trim();
        const stderr = (result.stderr ?? '').trim();
        if (result.status !== 0 || stdout.split('\n')[0]?.toUpperCase().startsWith('BLOCK')) {
          blocked = true;
          reason = stdout || stderr || `hook exited ${result.status ?? 'signal ' + result.signal}`;
        }
      } catch (err) {
        // A hook that fails to spawn denies (safer than silently allowing).
        blocked = true;
        reason = `hook error: ${(err as Error).message}`;
      }
      if (blocked) {
        return {
          behavior: 'deny',
          reason: `PreToolUse hook blocked: ${reason}`,
        };
      }
    }
    return undefined; // no hook blocked — fall through to normal permission flow
  };
}

// ── PostToolUse hooks (fire-and-forget after a tool completes) ──────────

export interface PostToolUseHook {
  matcher: string;
  command: string;
  description?: string;
}

export interface SessionStartHook {
  command: string;
  description?: string;
}

export function readPostToolUseHooks(raw: unknown): PostToolUseHook[] {
  const hooks = (raw as { hooks?: { PostToolUse?: unknown } } | null)?.hooks?.PostToolUse;
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((h): h is PostToolUseHook =>
    typeof h === 'object' && h !== null &&
    typeof (h as PostToolUseHook).matcher === 'string' &&
    typeof (h as PostToolUseHook).command === 'string');
}

export function readSessionStartHooks(raw: unknown): SessionStartHook[] {
  const hooks = (raw as { hooks?: { SessionStart?: unknown } } | null)?.hooks?.SessionStart;
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((h): h is SessionStartHook =>
    typeof h === 'object' && h !== null &&
    typeof (h as SessionStartHook).command === 'string');
}

function toolMatchesPattern(matcher: string, toolName: string): boolean {
  if (matcher === '*' || matcher === '') return true;
  const re = new RegExp('^' + matcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(toolName);
}

/**
 * Run matching PostToolUse shell commands after a tool completes.
 * Fire-and-forget — a failing hook is reported but never blocks the run.
 */
export function runPostToolUseHooks(
  loadHooks: () => PostToolUseHook[],
  publicName: string,
  input: unknown,
  output: unknown,
  workDir: string,
): void {
  const hooks = loadHooks().filter(h => toolMatchesPattern(h.matcher, publicName));
  if (hooks.length === 0) return;
  for (const hook of hooks) {
    try {
      spawnSync(hook.command, {
        shell: true,
        cwd: workDir,
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          ACTOVIQ_HOOK_EVENT: 'PostToolUse',
          ACTOVIQ_HOOK_TOOL: publicName,
          ACTOVIQ_HOOK_INPUT: JSON.stringify(input ?? {}).slice(0, 4000),
          ACTOVIQ_HOOK_OUTPUT: typeof output === 'string' ? output.slice(0, 8000) : JSON.stringify(output ?? {}).slice(0, 8000),
        },
      });
    } catch {
      // best-effort — post hooks never block
    }
  }
}

/**
 * Run SessionStart shell commands when a session is loaded/created.
 * Fire-and-forget — failures are silent.
 */
export function runSessionStartHooks(
  loadHooks: () => SessionStartHook[],
  workDir: string,
): void {
  const hooks = loadHooks();
  for (const hook of hooks) {
    try {
      spawnSync(hook.command, {
        shell: true,
        cwd: workDir,
        input: '',
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ACTOVIQ_HOOK_EVENT: 'SessionStart' },
      });
    } catch {
      // best-effort
    }
  }
}
