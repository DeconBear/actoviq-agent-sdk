import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { CreateAgentSdkOptions, ResolvedRuntimeConfig } from '../types.js';
import { getLoadedJsonConfig } from './loadJsonConfigFile.js';

const LEGACY_ENV_KEYS = {
  apiKey: ['ANTH', 'ROPIC_API_KEY'].join(''),
  authToken: ['ANTH', 'ROPIC_AUTH_TOKEN'].join(''),
  model: ['ANTH', 'ROPIC_MODEL'].join(''),
  baseUrl: ['ANTH', 'ROPIC_BASE_URL'].join(''),
  defaultSonnetModel: ['ANTH', 'ROPIC_DEFAULT_SONNET_MODEL'].join(''),
  defaultOpusModel: ['ANTH', 'ROPIC_DEFAULT_OPUS_MODEL'].join(''),
  defaultHaikuModel: ['ANTH', 'ROPIC_DEFAULT_HAIKU_MODEL'].join(''),
} as const;

const FALLBACK_MODEL = ['cl', 'aude-sonnet-4-5-20250929'].join('');
const DEFAULT_COMPACT_CONFIG = {
  enabled: true,
  autoCompactThresholdTokens: 20_000,
  preserveRecentMessages: 8,
  maxSummaryTokens: 1_024,
  microcompactEnabled: true,
  microcompactKeepRecentToolResults: 3,
  microcompactMinContentChars: 1_000,
} as const;

function getConfigValue(
  source: NodeJS.ProcessEnv | Record<string, string>,
  primaryKey: string,
  legacyKey?: string,
): string | undefined {
  return source[primaryKey] ?? (legacyKey ? source[legacyKey] : undefined);
}

export async function resolveRuntimeConfig(
  options: CreateAgentSdkOptions = {},
): Promise<ResolvedRuntimeConfig> {
  const homeDir = options.homeDir ?? os.homedir();
  const loadedConfig = getLoadedJsonConfig();

  const envFromLoadedConfig = loadedConfig?.env ?? {};
  const envFromProcess = process.env;

  const apiKey =
    options.apiKey ??
    getConfigValue(envFromProcess, 'ACTOVIQ_API_KEY', LEGACY_ENV_KEYS.apiKey) ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_API_KEY', LEGACY_ENV_KEYS.apiKey);
  const authToken =
    options.authToken ??
    getConfigValue(envFromProcess, 'ACTOVIQ_AUTH_TOKEN', LEGACY_ENV_KEYS.authToken) ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_AUTH_TOKEN', LEGACY_ENV_KEYS.authToken);

  if (!options.modelApi && !apiKey && !authToken) {
    throw new ConfigurationError(
      loadedConfig
        ? `No Actoviq credential was found. Checked process.env and "${loadedConfig.path}".`
        : 'No Actoviq credential was found. Checked process.env and the preloaded JSON config. Call loadJsonConfigFile(...) before createAgentSdk() if you want to use a JSON file.',
    );
  }

  const model =
    options.model ??
    getConfigValue(envFromProcess, 'ACTOVIQ_MODEL', LEGACY_ENV_KEYS.model) ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_MODEL', LEGACY_ENV_KEYS.model) ??
    getConfigValue(
      envFromLoadedConfig,
      'ACTOVIQ_DEFAULT_SONNET_MODEL',
      LEGACY_ENV_KEYS.defaultSonnetModel,
    ) ??
    getConfigValue(
      envFromLoadedConfig,
      'ACTOVIQ_DEFAULT_OPUS_MODEL',
      LEGACY_ENV_KEYS.defaultOpusModel,
    ) ??
    getConfigValue(
      envFromLoadedConfig,
      'ACTOVIQ_DEFAULT_HAIKU_MODEL',
      LEGACY_ENV_KEYS.defaultHaikuModel,
    ) ??
    FALLBACK_MODEL;

  return {
    homeDir,
    loadedConfigPath: loadedConfig?.path,
    apiKey,
    authToken,
    baseURL:
      options.baseURL ??
      getConfigValue(envFromProcess, 'ACTOVIQ_BASE_URL', LEGACY_ENV_KEYS.baseUrl) ??
      getConfigValue(envFromLoadedConfig, 'ACTOVIQ_BASE_URL', LEGACY_ENV_KEYS.baseUrl),
    model,
    maxTokens: options.maxTokens ?? 2048,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs ?? 120000,
    maxRetries: options.maxRetries ?? 2,
    workDir: options.workDir ?? process.cwd(),
    sessionDirectory:
      options.sessionDirectory ?? path.join(homeDir, '.actoviq', 'actoviq-agent-sdk'),
    clientName: options.clientName ?? 'actoviq-agent-sdk',
    clientVersion: options.clientVersion ?? '0.1.4',
    systemPrompt: options.systemPrompt,
    maxToolIterations: options.maxToolIterations ?? 12,
    userId: options.userId,
    metadata: { ...(options.metadata ?? {}) },
    compact: {
      ...DEFAULT_COMPACT_CONFIG,
      ...(options.compact ?? {}),
    },
  };
}
