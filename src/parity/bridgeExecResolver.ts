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

export { IS_WINDOWS };
