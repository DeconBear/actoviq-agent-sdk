import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type {
  ActoviqModelTierConfig,
  CreateAgentSdkOptions,
  ResolvedRuntimeConfig,
} from '../types.js';
import { getLoadedJsonConfig } from './loadJsonConfigFile.js';
import {
  resolveActoviqModelReference,
  selectDefaultActoviqModel,
} from './modelTiers.js';
import {
  getActoviqProjectSessionDirectory,
  migrateLegacyActoviqProjectSessions,
} from './projectSessionDirectory.js';

const OPENAI_FALLBACK_MODEL = 'gpt-4o';
const DEFAULT_COMPACT_CONFIG = {
  enabled: true,
  autoCompactThresholdTokens: 155_000,
  preserveRecentMessages: 8,
  maxSummaryTokens: 20_000,
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
  toolResultsPerMessageMaxChars: 200_000,
  loopAutoCompactEnabled: true,
  contextWindowTokens: 200_000,
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
  const workDir = path.resolve(options.workDir ?? process.cwd());
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

  const modelTiers: ActoviqModelTierConfig = {
    min: getRuntimeConfigValue('ACTOVIQ_DEFAULT_MIN_MODEL', ...envSources),
    medium: getRuntimeConfigValue('ACTOVIQ_DEFAULT_MEDIUM_MODEL', ...envSources),
    max: getRuntimeConfigValue('ACTOVIQ_DEFAULT_MAX_MODEL', ...envSources),
  };
  const requestedModel =
    options.model ??
    getRuntimeConfigValue('ACTOVIQ_MODEL', ...envSources);
  const selectedModel = requestedModel
    ? resolveActoviqModelReference(requestedModel, modelTiers)
    : provider === 'openai'
      ? selectDefaultActoviqModel(modelTiers, OPENAI_FALLBACK_MODEL)
      : selectDefaultActoviqModel(modelTiers, '');
  if (!selectedModel.model) {
    throw new ConfigurationError(
      'No model was configured. Set ACTOVIQ_MODEL, configure a min/medium/max model tier, or pass model to createAgentSdk().',
    );
  }

  const baseURL =
    options.baseURL ??
    getRuntimeConfigValue('ACTOVIQ_BASE_URL', ...envSources);

  const requestedFallbackModel =
    options.fallbackModel ??
    getRuntimeConfigValue('ACTOVIQ_FALLBACK_MODEL', ...envSources);
  const fallbackModel = requestedFallbackModel
    ? resolveActoviqModelReference(requestedFallbackModel, modelTiers).model
    : undefined;
  const requestedEffort =
    options.effort ??
    getRuntimeConfigValue('ACTOVIQ_EFFORT', ...envSources);
  if (
    requestedEffort !== undefined &&
    !['low', 'medium', 'high', 'max'].includes(requestedEffort)
  ) {
    throw new ConfigurationError(
      `Invalid effort "${requestedEffort}". Expected low, medium, high, or max.`,
    );
  }
  const sessionDirectory =
    options.sessionDirectory ?? getActoviqProjectSessionDirectory(workDir, homeDir);
  if (!options.sessionDirectory) {
    await migrateLegacyActoviqProjectSessions({
      homeDir,
      workDir,
      targetDirectory: sessionDirectory,
    });
  }

  return {
    homeDir,
    loadedConfigPath: loadedConfig?.path,
    apiKey,
    authToken,
    baseURL,
    model: selectedModel.model,
    modelTier: selectedModel.tier,
    modelTiers,
    maxTokens: options.maxTokens ?? 32000,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs ?? 600000,
    // Claude Code uses DEFAULT_MAX_RETRIES=10; long runs need to survive
    // transient 429/5xx windows instead of failing the whole session.
    maxRetries: options.maxRetries ?? 10,
    workDir,
    sessionDirectory,
    clientName: options.clientName ?? 'actoviq-agent-sdk',
    clientVersion: options.clientVersion ?? '0.1.7',
    systemPrompt: options.systemPrompt,
    // Unlimited by default, matching Claude Code's main-agent maxTurns
    // semantics: the loop ends when the model stops calling tools, on abort,
    // or via an explicit caller-provided limit.
    maxToolIterations: options.maxToolIterations ?? Number.POSITIVE_INFINITY,
    fallbackModel,
    promptCachingEnabled: options.promptCachingEnabled ?? true,
    userId: options.userId,
    metadata: { ...(options.metadata ?? {}) },
    compact: {
      ...DEFAULT_COMPACT_CONFIG,
      ...(options.compact ?? {}),
    },
    provider,
    effort: requestedEffort as ResolvedRuntimeConfig['effort'],
  };
}
