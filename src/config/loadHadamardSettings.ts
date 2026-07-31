import { ConfigurationError } from '../errors.js';
import type { HadamardSettingsData } from '../types.js';
import {
  clearLoadedJsonConfig,
  getLoadedJsonConfig,
  loadJsonConfigFile,
} from './loadJsonConfigFile.js';

export interface LoadHadamardSettingsOptions {
  settingsFile?: string;
}

export async function loadHadamardSettings(
  options: string | LoadHadamardSettingsOptions,
): Promise<HadamardSettingsData> {
  const settingsFile =
    typeof options === 'string' ? options : options.settingsFile;

  if (!settingsFile) {
    throw new ConfigurationError(
      'loadHadamardSettings now requires an explicit settingsFile path.',
    );
  }

  return loadJsonConfigFile(settingsFile);
}

export { clearLoadedJsonConfig, getLoadedJsonConfig };
