import path from 'node:path';

import { ConfigurationError } from '../errors.js';
import type {
  HadamardModelTierConfig,
  CreateAgentSdkOptions,
  ResolvedRuntimeConfig,
} from '../types.js';
import { getLoadedJsonConfig } from './loadJsonConfigFile.js';
import { migrateLegacyActoviqHomeIfNeeded, resolveHadamardHome } from './hadamardHome.js';
import {
  resolveHadamardModelReference,
  selectDefaultHadamardModel,
} from './modelTiers.js';
import {
  getHadamardProjectSessionDirectory,
  migrateLegacyHadamardProjectData,
} from './projectSessionDirectory.js';
import { resolveSandboxPolicy } from '../sandbox/policyResolver.js';
import { SandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { parseTypedHooks } from '../hooks/hookConfig.js';
import { loadPolicyDocuments } from '../policy/policyLoader.js';
import { resolvePolicy } from '../policy/policyResolver.js';
import { policySetting } from '../policy/runtimePolicy.js';

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
  apiMicrocompactClearToolResults: false,
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
  const keys = [primaryKey];
  if (primaryKey.startsWith('HADAMARD_')) {
    keys.push(`ACTOVIQ_${primaryKey.slice('HADAMARD_'.length)}`);
  }
  for (const source of sources) {
    for (const key of keys) {
      const value = getConfigValue(source, key);
      if (value != null && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

export async function resolveRuntimeConfig(
  options: CreateAgentSdkOptions = {},
): Promise<ResolvedRuntimeConfig> {
  if (!options.homeDir) {
    await migrateLegacyActoviqHomeIfNeeded().catch(() => undefined);
  }
  const homeDir = resolveHadamardHome(options.homeDir);
  const workDir = path.resolve(options.workDir ?? process.cwd());
  const loadedConfig = getLoadedJsonConfig();
  const effectivePolicy = resolvePolicy(await loadPolicyDocuments({
    homeDir,
    workDir,
    explicit: options.policyDocuments,
  }));

  const envFromLoadedConfig = loadedConfig?.env ?? {};
  const envSources = [envFromLoadedConfig, process.env];

  const apiKey =
    options.apiKey ??
    getRuntimeConfigValue('HADAMARD_API_KEY', ...envSources);
  const authToken =
    options.authToken ??
    getRuntimeConfigValue('HADAMARD_AUTH_TOKEN', ...envSources);

  if (!options.modelApi && !apiKey && !authToken) {
    throw new ConfigurationError(
      loadedConfig
        ? `No Hadamard credential was found. Checked "${loadedConfig.path}".`
        : 'No Hadamard credential was found. Call loadJsonConfigFile(...) before createAgentSdk() to use a JSON file.',
    );
  }

  const provider =
    options.provider ??
    (getRuntimeConfigValue('HADAMARD_PROVIDER', ...envSources) as 'anthropic' | 'openai' | undefined) ??
    'anthropic';

  const modelTiers: HadamardModelTierConfig = {
    min: getRuntimeConfigValue('HADAMARD_DEFAULT_MIN_MODEL', ...envSources),
    medium: getRuntimeConfigValue('HADAMARD_DEFAULT_MEDIUM_MODEL', ...envSources),
    max: getRuntimeConfigValue('HADAMARD_DEFAULT_MAX_MODEL', ...envSources),
  };
  const requestedModel =
    policySetting<string>(effectivePolicy, 'model') ??
    options.model ??
    getRuntimeConfigValue('HADAMARD_MODEL', ...envSources);
  const selectedModel = requestedModel
    ? resolveHadamardModelReference(requestedModel, modelTiers)
    : provider === 'openai'
      ? selectDefaultHadamardModel(modelTiers, OPENAI_FALLBACK_MODEL)
      : selectDefaultHadamardModel(modelTiers, '');
  if (!selectedModel.model) {
    throw new ConfigurationError(
      'No model was configured. Set HADAMARD_MODEL, configure a min/medium/max model tier, or pass model to createAgentSdk().',
    );
  }

  const baseURL =
    options.baseURL ??
    getRuntimeConfigValue('HADAMARD_BASE_URL', ...envSources);

  const requestedFallbackModel =
    options.fallbackModel ??
    getRuntimeConfigValue('HADAMARD_FALLBACK_MODEL', ...envSources);
  const fallbackModel = requestedFallbackModel
    ? resolveHadamardModelReference(requestedFallbackModel, modelTiers).model
    : undefined;
  const requestedEffort =
    policySetting<string>(effectivePolicy, 'effort') ??
    options.effort ??
    getRuntimeConfigValue('HADAMARD_EFFORT', ...envSources);
  if (
    requestedEffort !== undefined &&
    !['low', 'medium', 'high', 'max'].includes(requestedEffort)
  ) {
    throw new ConfigurationError(
      `Invalid effort "${requestedEffort}". Expected low, medium, high, or max.`,
    );
  }
  const sessionDirectory =
    options.sessionDirectory ?? getHadamardProjectSessionDirectory(workDir, homeDir);
  if (!options.sessionDirectory) {
    try {
      await migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: sessionDirectory,
      });
    } catch (error) {
      console.warn(
        `Could not migrate legacy Hadamard project data: ${(error as Error).message}`,
      );
    }
  }
  const rawSandbox = loadedConfig?.raw?.sandbox;
  const configuredSandbox = rawSandbox && typeof rawSandbox === 'object' && !Array.isArray(rawSandbox)
    ? rawSandbox as import('../sandbox/policyResolver.js').SandboxPolicyInput
    : undefined;
  const sandbox = resolveSandboxPolicy(
    workDir,
    policySetting<import('../sandbox/policyResolver.js').SandboxPolicyInput>(
      effectivePolicy,
      'sandbox',
    ),
    configuredSandbox,
    options.sandbox,
  );
  const sandboxCapabilities = new SandboxExecutor(sandbox).capability;
  const languageServers = options.languageServers
    ?? normalizeLanguageServers(loadedConfig?.raw?.languageServers);
  const typedHookConfig = options.typedHooks
    ? { hooks: options.typedHooks, issues: [] }
    : parseTypedHooks(loadedConfig?.raw?.typedHooks);
  if (typedHookConfig.issues.length > 0) {
    throw new ConfigurationError(typedHookConfig.issues.join(' '));
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
    runTimeoutMs: resolvePositiveTimeout(options.runTimeoutMs, 15 * 60_000, 'runTimeoutMs'),
    toolTimeoutMs: resolvePositiveTimeout(options.toolTimeoutMs, 2 * 60_000, 'toolTimeoutMs'),
    hookTimeoutMs: resolvePositiveTimeout(options.hookTimeoutMs, 30_000, 'hookTimeoutMs'),
    mcpTimeoutMs: resolvePositiveTimeout(options.mcpTimeoutMs, 2 * 60_000, 'mcpTimeoutMs'),
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
    sandbox,
    sandboxCapabilities,
    languageServers,
    typedHooks: typedHookConfig.hooks,
    autoWorktree:
      policySetting<boolean>(effectivePolicy, 'autoWorktree')
      ?? options.autoWorktree
      ?? (typeof loadedConfig?.raw?.autoWorktree === 'boolean'
        ? loadedConfig.raw.autoWorktree
        : false),
    effectivePolicy,
  };
}

function normalizeLanguageServers(
  value: unknown,
): import('../codeIntel/types.js').LanguageServerDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || typeof record.command !== 'string'
      || !Array.isArray(record.languages)
      || !Array.isArray(record.extensions)
    ) return [];
    return [{
      id: record.id,
      command: record.command,
      languages: record.languages.filter((entry): entry is string => typeof entry === 'string'),
      extensions: record.extensions.filter((entry): entry is string => typeof entry === 'string'),
      ...(Array.isArray(record.args)
        ? { args: record.args.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      ...(record.initializationOptions !== undefined
        ? { initializationOptions: record.initializationOptions }
        : {}),
    }];
  });
}

function resolvePositiveTimeout(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ConfigurationError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}
