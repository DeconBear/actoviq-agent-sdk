import { readFile } from 'node:fs/promises';

import { ConfigurationError } from '../errors.js';
import type { LoadedJsonConfigData } from '../types.js';
import { isRecord } from '../runtime/helpers.js';

export interface LoadJsonConfigFileOptions {
  filePath: string;
}

let loadedJsonConfig: LoadedJsonConfigData | null = null;

export async function loadJsonConfigFile(
  filePathOrOptions: string | LoadJsonConfigFileOptions,
): Promise<LoadedJsonConfigData> {
  const filePath =
    typeof filePathOrOptions === 'string'
      ? filePathOrOptions
      : filePathOrOptions.filePath;

  if (!filePath) {
    throw new ConfigurationError('A JSON config file path is required.');
  }

  try {
    const rawText = await readFile(filePath, 'utf8');
    const parsed = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
    if (!isRecord(parsed)) {
      throw new ConfigurationError(`JSON config at "${filePath}" must contain a JSON object.`);
    }

    loadedJsonConfig = {
      path: filePath,
      exists: true,
      env: extractEnv(parsed),
      permissions: isRecord(parsed.permissions) ? parsed.permissions : undefined,
      raw: parsed,
    };

    return structuredClone(loadedJsonConfig);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigurationError(`Failed to parse JSON config at "${filePath}".`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function getLoadedJsonConfig(): LoadedJsonConfigData | null {
  return loadedJsonConfig ? structuredClone(loadedJsonConfig) : null;
}

export function clearLoadedJsonConfig(): void {
  loadedJsonConfig = null;
}

function extractEnv(parsed: Record<string, unknown>): Record<string, string> {
  if (isRecord(parsed.env)) {
    return Object.fromEntries(
      Object.entries(parsed.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        /^[A-Z0-9_]+$/.test(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}
