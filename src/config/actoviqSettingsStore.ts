import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { getLoadedJsonConfig, loadJsonConfigFile } from './loadJsonConfigFile.js';
import { ConfigurationError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';

export interface ResolveActoviqSettingsStoreOptions {
  configPath?: string;
  homeDir?: string;
}

export interface ResolvedActoviqSettingsStore {
  configPath: string;
  homeDir: string;
  raw: Record<string, unknown>;
}

export function getDefaultActoviqSettingsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.actoviq', 'settings.json');
}

export async function resolveActoviqSettingsStore(
  options: ResolveActoviqSettingsStoreOptions = {},
): Promise<ResolvedActoviqSettingsStore> {
  const loaded = getLoadedJsonConfig();
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? loaded?.path ?? getDefaultActoviqSettingsPath(homeDir);
  const raw =
    loaded?.path === configPath && loaded.raw && isRecord(loaded.raw)
      ? structuredClone(loaded.raw)
      : await readActoviqSettingsFile(configPath);

  return {
    configPath,
    homeDir,
    raw,
  };
}

export async function persistActoviqSettingsStore(
  configPath: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const loaded = getLoadedJsonConfig();
  if (loaded?.path === configPath) {
    await loadJsonConfigFile(configPath);
  }
}

async function readActoviqSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new ConfigurationError(`JSON config at "${filePath}" must contain an object.`);
    }

    return parsed;
  } catch (error) {
    const normalized = error as NodeJS.ErrnoException;
    if (normalized?.code === 'ENOENT') {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new ConfigurationError(`Failed to parse JSON config at "${filePath}".`, {
        cause: error,
      });
    }
    throw error;
  }
}
