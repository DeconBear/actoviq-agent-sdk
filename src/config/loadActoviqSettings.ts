import { ConfigurationError } from '../errors.js';
import type { ActoviqSettingsData } from '../types.js';
import {
  clearLoadedJsonConfig,
  getLoadedJsonConfig,
  loadJsonConfigFile,
} from './loadJsonConfigFile.js';

export interface LoadActoviqSettingsOptions {
  settingsFile?: string;
}

export async function loadActoviqSettings(
  options: string | LoadActoviqSettingsOptions,
): Promise<ActoviqSettingsData> {
  const settingsFile =
    typeof options === 'string' ? options : options.settingsFile;

  if (!settingsFile) {
    throw new ConfigurationError(
      'loadActoviqSettings now requires an explicit settingsFile path.',
    );
  }

  return loadJsonConfigFile(settingsFile);
}

export { clearLoadedJsonConfig, getLoadedJsonConfig };
