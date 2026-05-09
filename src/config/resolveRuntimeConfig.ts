import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type { CreateAgentSdkOptions, ResolvedRuntimeConfig } from '../types.js';
import { getLoadedJsonConfig } from './loadJsonConfigFile.js';

const FALLBACK_MODEL = 'claude-sonnet-4-5-20250929';
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
  apiMicrocompactClearToolResults: true,
  apiMicrocompactClearToolUses: false,
} as const;

function getConfigValue(
  source: NodeJS.ProcessEnv | Record<string, string>,
  primaryKey: string,
): string | undefined {
  return source[primaryKey];
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
    getConfigValue(envFromProcess, 'ACTOVIQ_API_KEY') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_API_KEY');
  const authToken =
    options.authToken ??
    getConfigValue(envFromProcess, 'ACTOVIQ_AUTH_TOKEN') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_AUTH_TOKEN');

  if (!options.modelApi && !apiKey && !authToken) {
    throw new ConfigurationError(
      loadedConfig
        ? `No Actoviq credential was found. Checked process.env and "${loadedConfig.path}".`
        : 'No Actoviq credential was found. Checked process.env and the preloaded JSON config. Call loadJsonConfigFile(...) before createAgentSdk() if you want to use a JSON file.',
    );
  }

  // Only auto-detect models that are definitively OpenAI-native.
  // Third-party providers (deepseek, etc.) may use either protocol —
  // rely on explicit ACTOVIQ_PROVIDER or the default provider.
  const OPENAI_MODEL_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'o1-', 'o3-', 'o4-'];

  // Known base URLs for third-party OpenAI-compatible providers.
  // Only applied when provider is explicitly or auto-detected as 'openai'.
  const OPENAI_PROVIDER_BASE_URLS: Record<string, string> = {
    'deepseek-': 'https://api.deepseek.com',
  };

  const explicitProvider =
    options.provider ??
    (getConfigValue(envFromProcess, 'ACTOVIQ_PROVIDER') as 'anthropic' | 'openai' | undefined) ??
    (getConfigValue(envFromLoadedConfig, 'ACTOVIQ_PROVIDER') as 'anthropic' | 'openai' | undefined);

  // Resolve model before provider in case we need to auto-detect
  const detectedModel =
    options.model ??
    getConfigValue(envFromProcess, 'ACTOVIQ_MODEL') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_MODEL') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_DEFAULT_SONNET_MODEL') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_DEFAULT_OPUS_MODEL') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_DEFAULT_HAIKU_MODEL');

  const autoProvider = detectedModel && OPENAI_MODEL_PREFIXES.some((p) => detectedModel.startsWith(p))
    ? 'openai'
    : 'anthropic';

  const provider = explicitProvider ?? autoProvider;

  // Auto-detect base URL for known providers when not explicitly set
  const explicitBaseURL =
    options.baseURL ??
    getConfigValue(envFromProcess, 'ACTOVIQ_BASE_URL') ??
    getConfigValue(envFromLoadedConfig, 'ACTOVIQ_BASE_URL');
  const autoBaseURL = detectedModel
    ? (() => {
        const key = Object.keys(OPENAI_PROVIDER_BASE_URLS).find((k) => detectedModel.startsWith(k));
        return key ? OPENAI_PROVIDER_BASE_URLS[key] : undefined;
      })()
    : undefined;

  const fallbackModel = provider === 'openai' ? OPENAI_FALLBACK_MODEL : FALLBACK_MODEL;
  const model = detectedModel ?? fallbackModel;

  return {
    homeDir,
    loadedConfigPath: loadedConfig?.path,
    apiKey,
    authToken,
    baseURL: explicitBaseURL ?? autoBaseURL,
    model,
    maxTokens: options.maxTokens ?? 2048,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs ?? 120000,
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
