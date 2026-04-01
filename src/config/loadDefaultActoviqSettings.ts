import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { LoadedJsonConfigData } from '../types.js';
import { loadJsonConfigFile } from './loadJsonConfigFile.js';

export interface LoadDefaultActoviqSettingsOptions {
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

export async function loadDefaultActoviqSettings(
  options: LoadDefaultActoviqSettingsOptions = {},
): Promise<LoadedJsonConfigData> {
  const homeDir = options.homeDir ?? os.homedir();
  const candidates =
    options.candidates ??
    [path.join(homeDir, '.actoviq', 'settings.json')];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return loadJsonConfigFile(candidate);
    }
  }

  throw new ConfigurationError(
    `No default settings file was found. Checked: ${candidates.map((candidate) => `"${candidate}"`).join(', ')}`,
  );
}
