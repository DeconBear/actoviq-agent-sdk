import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { LoadedJsonConfigData } from '../types.js';
import { resolveHadamardHome } from './hadamardHome.js';
import { loadJsonConfigFile } from './loadJsonConfigFile.js';

export interface LoadDefaultHadamardSettingsOptions {
  homeDir?: string;
  candidates?: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadDefaultHadamardSettings(
  options: LoadDefaultHadamardSettingsOptions = {},
): Promise<LoadedJsonConfigData> {
  const candidates =
    options.candidates ??
    [path.join(resolveHadamardHome(options.homeDir), 'settings.json')];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return loadJsonConfigFile(candidate);
    }
  }

  throw new ConfigurationError(
    `No default settings file was found. Checked: ${candidates.map((candidate) => `"${candidate}"`).join(', ')}`,
  );
}
