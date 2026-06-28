/**
 * Executable resolution primitives shared by the bridge SDK and its provider
 * layer. Kept in a leaf module so `bridgeProviders.ts` can resolve a provider
 * binary on PATH without importing the full `actoviqBridgeSdk.ts` (which would
 * create a circular import).
 */

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, IS_WINDOWS ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function splitPathEnv(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue.split(path.delimiter).filter(Boolean);
}

export async function findExecutableOnPath(name: string): Promise<string | undefined> {
  const pathDirectories = splitPathEnv(process.env.PATH);
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];

  for (const directory of pathDirectories) {
    const directCandidate = path.join(directory, name);
    if (!IS_WINDOWS && (await isExecutable(directCandidate))) {
      return directCandidate;
    }

    for (const extension of extensions) {
      const candidate = directCandidate.endsWith(extension.toLowerCase())
        ? directCandidate
        : `${directCandidate}${extension.toLowerCase()}`;
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export async function findFirstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const WINDOWS_SHELL_SAFE = /^[A-Za-z0-9@_+=:,./-]+$/;

/**
 * Quote a single argument for `cmd.exe` when `spawn(..., { shell: true })` is
 * used (required for `.cmd`/`.bat` shims on Windows). Node's `shell: true`
 * joins args with spaces and passes them to `cmd /c` UNquoted, so an arg
 * containing a space — e.g. the prompt passed to `claude -p "<prompt>"` —
 * gets split by cmd.exe into multiple tokens ("My favorite number…" → "My").
 * This wraps space-containing args in double quotes and escapes internal
 * quotes/backslashes per the cmd.exe command-line parsing rules.
 *
 * Only meaningful when spawning through a shell; argv-mode spawns pass each
 * arg verbatim and must NOT be pre-quoted.
 */
export function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""';
  if (WINDOWS_SHELL_SAFE.test(arg)) return arg;
  // Double backslashes that precede a quote, escape the quote, then double
  // any trailing backslashes (so they don't escape the closing quote).
  const escaped = arg
    .replace(/(\\*)"/g, (_m, bs: string) => bs + bs + '\\"')
    .replace(/(\\*)$/, (_m, bs: string) => bs + bs);
  return `"${escaped}"`;
}

export { IS_WINDOWS };
