import path from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

import { getLoadedJsonConfig, loadJsonConfigFile } from './loadJsonConfigFile.js';
import { ConfigurationError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import { resolveHadamardHome } from './hadamardHome.js';

export interface ResolveHadamardSettingsStoreOptions {
  configPath?: string;
  homeDir?: string;
}

export interface ResolvedHadamardSettingsStore {
  configPath: string;
  homeDir: string;
  raw: Record<string, unknown>;
}

export function getDefaultHadamardSettingsPath(homeDir?: string): string {
  return path.join(resolveHadamardHome(homeDir), 'settings.json');
}

export async function resolveHadamardSettingsStore(
  options: ResolveHadamardSettingsStoreOptions = {},
): Promise<ResolvedHadamardSettingsStore> {
  const loaded = getLoadedJsonConfig();
  const hadamardHome = resolveHadamardHome(options.homeDir);
  const configPath = options.configPath ?? loaded?.path ?? path.join(hadamardHome, 'settings.json');
  const raw =
    loaded?.path === configPath && loaded.raw && isRecord(loaded.raw)
      ? structuredClone(loaded.raw)
      : await readHadamardSettingsFile(configPath);

  return {
    configPath,
    homeDir: hadamardHome,
    raw,
  };
}

export async function persistHadamardSettingsStore(
  configPath: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600);
  }

  const loaded = getLoadedJsonConfig();
  if (loaded?.path === configPath) {
    await loadJsonConfigFile(configPath);
  }
}

async function readHadamardSettingsFile(filePath: string): Promise<Record<string, unknown>> {
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
