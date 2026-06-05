import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { CreateAgentSdkOptions, ResolvedRuntimeConfig } from '../types.js';
import { getLoadedJsonConfig } from './loadJsonConfigFile.js';

const FALLBACK_MODEL = 'claude-medium-4-5-20250929';
const OPENAI_FALLBACK_MODEL = 'gpt-4o';
const DEFAULT_COMPACT_CONFIG = {
  enabled: true,
  autoCompactThresholdTokens: 20_000,
  preserveRecentMessages: 8,
  maxSummaryTokens: 1_024,
  microcompactEnabled: true,
  microcompactKeepRecentToolResults: 3,
  microcompactMinContentChars: 1_000,
  apiMicrocompactEnabled: true,
  apiMicrocompactMaxInputTokens: 180_000,
  apiMicrocompactTargetInputTokens: 40_000,
  apiMicrocompactMaxRequestBytes: 1_500_000,
  apiMicrocompactClearToolResults: true,
  apiMicrocompactClearToolUses: false,
  toolResultArtifactMaxChars: 80_000,
} as const;

function getConfigValue(
  source: NodeJS.ProcessEnv | Record<string, string>,
  primaryKey: string,
): string | undefined {
  return source[primaryKey];
}

function getRuntimeConfigValue(
  primaryKey: string,
  ...sources: Array<NodeJS.ProcessEnv | Record<string, string>>
): string | undefined {
  for (const source of sources) {
    const value = getConfigValue(source, primaryKey);
    if (value != null && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export async function resolveRuntimeConfig(
  options: CreateAgentSdkOptions = {},
): Promise<ResolvedRuntimeConfig> {
  const homeDir = options.homeDir ?? os.homedir();
  const loadedConfig = getLoadedJsonConfig();

  const envFromLoadedConfig = loadedConfig?.env ?? {};
  const envSources = [envFromLoadedConfig, process.env];

  const apiKey =
    options.apiKey ??
    getRuntimeConfigValue('ACTOVIQ_API_KEY', ...envSources);
  const authToken =
    options.authToken ??
    getRuntimeConfigValue('ACTOVIQ_AUTH_TOKEN', ...envSources);

  if (!options.modelApi && !apiKey && !authToken) {
    throw new ConfigurationError(
      loadedConfig
        ? `No Actoviq credential was found. Checked "${loadedConfig.path}".`
        : 'No Actoviq credential was found. Call loadJsonConfigFile(...) before createAgentSdk() to use a JSON file.',
    );
  }

  const provider =
    options.provider ??
    (getRuntimeConfigValue('ACTOVIQ_PROVIDER', ...envSources) as 'anthropic' | 'openai' | undefined) ??
    'anthropic';

  const model =
    options.model ??
    getRuntimeConfigValue('ACTOVIQ_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_MAX_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_max_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_MEDIUM_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_medium_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_MIN_MODEL', ...envSources) ??
    getRuntimeConfigValue('ACTOVIQ_DEFAULT_min_MODEL', ...envSources) ??
    (provider === 'openai' ? OPENAI_FALLBACK_MODEL : FALLBACK_MODEL);

  const baseURL =
    options.baseURL ??
    getRuntimeConfigValue('ACTOVIQ_BASE_URL', ...envSources);

  return {
    homeDir,
    loadedConfigPath: loadedConfig?.path,
    apiKey,
    authToken,
    baseURL,
    model,
    maxTokens: options.maxTokens ?? 32000,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs ?? 600000,
    maxRetries: options.maxRetries ?? 2,
    workDir: options.workDir ?? process.cwd(),
    sessionDirectory:
      options.sessionDirectory ?? path.join(homeDir, '.actoviq', 'actoviq-agent-sdk'),
    clientName: options.clientName ?? 'actoviq-agent-sdk',
    clientVersion: options.clientVersion ?? '0.1.7',
    systemPrompt: options.systemPrompt,
    maxToolIterations: options.maxToolIterations ?? 20,
    userId: options.userId,
    metadata: { ...(options.metadata ?? {}) },
    compact: {
      ...DEFAULT_COMPACT_CONFIG,
      ...(options.compact ?? {}),
    },
    provider,
  };
}
