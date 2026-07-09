import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { LoadedJsonConfigData } from '../types.js';
import { resolveActoviqHome } from './actoviqHome.js';
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
  const candidates =
    options.candidates ??
    [path.join(resolveActoviqHome(options.homeDir), 'settings.json')];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return loadJsonConfigFile(candidate);
    }
  }

  throw new ConfigurationError(
    `No default settings file was found. Checked: ${candidates.map((candidate) => `"${candidate}"`).join(', ')}`,
  );
}
