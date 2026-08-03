/**
 * Named bridge connection configs (apiKey + baseURL presets).
 *
 * Persisted to ~/.hadamard/bridge-configs.json. Each config bundles a provider
 * (now 'anthropic'|'openai' — the in-process SDK enum) plus apiKey/baseURL/model
 * so the user can pre-configure e.g. one anthropic profile pointed at DeepSeek
 * and another at Qwen, and switch between them by name.
 *
 * At activation the TUI pre-builds a ModelApi via buildRouteModelApi and injects
 * it per-run into session.stream({model, modelApi}) — same session, no child
 * process, context naturally survives switching bridge↔hadamard.
 *
 * Legacy config files stored provider as RuntimeProviderId ('claude'|'pi'|…);
 * readBridgeConfigs auto-migrates these to 'anthropic'|'openai'.
 * Mirrors mcpServerConfig for persistence.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveHadamardHome } from '../config/hadamardHome.js';

export type InProcessProvider = 'anthropic' | 'openai';

export type BridgeExecutionMode = 'api' | 'cli';

export type BridgeAuthSource = 'native' | 'apiKey';

export type ModelModality = 'text' | 'multimodal';

/** Runtime kind — the product / endpoint the config connects to.
 *
 *  `hadamard`    — use the SDK's default provider (clean SDK, no separate credentials)
 *  `claude`      — Anthropic / Claude API (Anthropic wire protocol)
 *  `codewhale`   — CodeWhale API (Anthropic wire protocol)
 *  `pi`          — Pi API (OpenAI wire protocol)
 *  `codex`       — Codex API (OpenAI wire protocol)
 *  `reasonix`    — Reasonix API (OpenAI wire protocol)
 *  `crush`       — Crush API (OpenAI wire protocol)
 */
export type BridgeRuntime =
  | 'hadamard'
  | 'claude'
  | 'codewhale'
  | 'pi'
  | 'codex'
  | 'reasonix'
  | 'crush';

export type ManagedExternalCliRuntime = Exclude<BridgeRuntime, 'hadamard'>;
export const MANAGED_EXTERNAL_CLI_RUNTIMES: readonly ManagedExternalCliRuntime[] = [
  'claude',
  'codewhale',
  'pi',
  'codex',
  'reasonix',
  'crush',
];

export function isManagedExternalCliRuntime(
  runtime: BridgeRuntime,
): runtime is ManagedExternalCliRuntime {
  return (MANAGED_EXTERNAL_CLI_RUNTIMES as readonly string[]).includes(runtime);
}

/** Map a runtime id to the wire protocol (in-process provider). */
export function runtimeToProvider(rt: BridgeRuntime): InProcessProvider | null {
  switch (rt) {
    case 'claude':
    case 'codewhale':
      return 'anthropic';
    case 'reasonix':
    case 'pi':
    case 'codex':
    case 'crush':
      return 'openai';
    default:
      return null; // hadamard — no separate provider
  }
}

export interface ProviderModelEntry {
  /** Model id (e.g. "deepseek-chat", "gpt-4o"). */
  name: string;
  /** Whether the model supports 1 M context. */
  context1M?: boolean;
  contextWindowTokens?: number;
  maxContextWindowTokens?: number;
  effectiveContextWindowPercent?: number;
  autoCompactTokenLimit?: number;
  /** Text-only or multimodal (vision). */
  modality?: ModelModality;
}

export interface PersistedBridgeConfig {
  name: string;
  /** Runtime: 'hadamard' uses the SDK's default provider/credentials;
   *  'bridge' uses this config's provider/apiKey/baseURL. */
  runtime: BridgeRuntime;
  /** Existing configs without this field are migrated to direct API mode. */
  execution?: BridgeExecutionMode;
  /** CLI mode defaults to the runtime's native login/configuration. */
  authSource?: BridgeAuthSource;
  /** Provider selected inside a multi-provider CLI (for example openai or anthropic). */
  credentialProvider?: string;
  /** Whether a managed CLI may load project-local runtime configuration/resources. */
  trustProjectResources?: boolean;
  provider: InProcessProvider;
  apiKey?: string;
  baseURL?: string;
  /** The currently selected model for this config. */
  model?: string;
  /** Registered models for this config (display + quick-switch). */
  models?: ProviderModelEntry[];
}

export interface PersistedBridgeConfigs {
  configs: PersistedBridgeConfig[];
}

const VALID_PROVIDERS: InProcessProvider[] = ['anthropic', 'openai'];
const VALID_EXECUTION_MODES: BridgeExecutionMode[] = ['api', 'cli'];
const VALID_AUTH_SOURCES: BridgeAuthSource[] = ['native', 'apiKey'];
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Legacy RuntimeProviderId → InProcessProvider migration (v0.6→v0.7).
// The TUI used to spawn external CLIs keyed by these ids; now the bridge is
// in-process and configs carry only 'anthropic'|'openai'. Best-effort mapping
// preserves saved configs across the upgrade.
const LEGACY_PROVIDER_MIGRATION: Record<string, InProcessProvider> = {
  claude: 'anthropic',
  codewhale: 'anthropic',
  pi: 'openai',
  codex: 'openai',
  reasonix: 'openai',
  crush: 'openai',
};

function migrateProvider(raw: string): InProcessProvider {
  if ((VALID_PROVIDERS as string[]).includes(raw)) return raw as InProcessProvider;
  return LEGACY_PROVIDER_MIGRATION[raw] ?? 'anthropic'; // fallback safe: unknown → anthropic
}

export function getBridgeConfigsPath(homeDir?: string): string {
  return path.join(resolveHadamardHome(homeDir), 'bridge-configs.json');
}

export const VALID_RUNTIMES: BridgeRuntime[] = ['hadamard', 'claude', 'codewhale', 'pi', 'codex', 'reasonix', 'crush'];

function isValidRuntime(raw: unknown): raw is BridgeRuntime {
  return (VALID_RUNTIMES as string[]).includes(raw as string);
}

function isValidConfig(value: unknown): value is PersistedBridgeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === 'string' && typeof c.provider === 'string';
}

function normalizeBridgeConfig(c: PersistedBridgeConfig): PersistedBridgeConfig {
  const execution = VALID_EXECUTION_MODES.includes(c.execution as BridgeExecutionMode)
    ? c.execution as BridgeExecutionMode
    : 'api';
  const out: PersistedBridgeConfig = {
    name: c.name,
    provider: migrateProvider(c.provider),
    // Pre-v0.8 legacy: missing/unknown runtime defaults to 'claude'.
    runtime: isValidRuntime(c.runtime) ? c.runtime : 'claude',
    execution,
    authSource: VALID_AUTH_SOURCES.includes(c.authSource as BridgeAuthSource)
      ? c.authSource as BridgeAuthSource
      : execution === 'cli' ? 'native' : 'apiKey',
  };
  if (typeof c.apiKey === 'string' && c.apiKey) out.apiKey = c.apiKey;
  if (typeof c.baseURL === 'string' && c.baseURL) out.baseURL = c.baseURL;
  if (typeof c.credentialProvider === 'string' && c.credentialProvider.trim()) {
    out.credentialProvider = c.credentialProvider.trim();
  }
  if (typeof c.trustProjectResources === 'boolean') {
    out.trustProjectResources = c.trustProjectResources;
  }
  if (typeof c.model === 'string' && c.model) out.model = c.model;
  if (Array.isArray(c.models)) {
    out.models = c.models.filter(
      (m: unknown): m is ProviderModelEntry =>
        typeof m === 'object' && m !== null && typeof (m as ProviderModelEntry).name === 'string',
    ).map(normalizeProviderModelEntry);
  }
  return out;
}

function normalizeProviderModelEntry(model: ProviderModelEntry): ProviderModelEntry {
  const contextWindowTokens = positiveInteger(model.contextWindowTokens)
    ?? (model.context1M === true ? 1_000_000 : undefined);
  return {
    name: model.name,
    ...(model.context1M === true ? { context1M: true } : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(positiveInteger(model.maxContextWindowTokens) != null
      ? { maxContextWindowTokens: positiveInteger(model.maxContextWindowTokens) }
      : {}),
    ...(validPercent(model.effectiveContextWindowPercent) != null
      ? { effectiveContextWindowPercent: validPercent(model.effectiveContextWindowPercent) }
      : {}),
    ...(positiveInteger(model.autoCompactTokenLimit) != null
      ? { autoCompactTokenLimit: positiveInteger(model.autoCompactTokenLimit) }
      : {}),
    ...(model.modality ? { modality: model.modality } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function validPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : undefined;
}

function serializeBridgeConfigs(configs: PersistedBridgeConfigs): string {
  return `${JSON.stringify(configs, null, 2)}\n`;
}

function secureConfigDirectory(directory: string): void {
  mkdirSync(directory, process.platform === 'win32'
    ? { recursive: true }
    : { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== 'win32') chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function secureConfigFile(file: string): void {
  if (process.platform !== 'win32') chmodSync(file, PRIVATE_FILE_MODE);
}

/** Write via temp+rename so a crash mid-write cannot leave a 0-byte configs file. */
function atomicWriteFile(file: string, contents: string): void {
  secureConfigDirectory(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, process.platform === 'win32'
    ? 'utf-8'
    : { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  secureConfigFile(tmp);
  try {
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* dest may not exist */
    }
    try {
      renameSync(tmp, file);
    } catch {
      copyFileSync(tmp, file);
      unlinkSync(tmp);
    }
  }
  secureConfigFile(file);
}

export function readBridgeConfigs(homeDir?: string): PersistedBridgeConfigs {
  const file = getBridgeConfigsPath(homeDir);
  if (!existsSync(file)) return { configs: [] };
  try {
    if (process.platform !== 'win32') {
      chmodSync(path.dirname(file), PRIVATE_DIRECTORY_MODE);
      secureConfigFile(file);
    }
    const raw = readFileSync(file, 'utf-8');
    // Empty/truncated files must not be treated as a successful empty config list
    // that later gets persisted — that is how named configs were wiped before.
    if (!raw.trim()) return { configs: [] };
    const parsed = JSON.parse(raw);
    const configs = Array.isArray(parsed.configs)
      ? parsed.configs.filter(isValidConfig).map((c: PersistedBridgeConfig) => normalizeBridgeConfig(c))
      : [];
    const next = { configs };
    const serialized = serializeBridgeConfigs(next);
    // Only rewrite when migration actually changed on-disk contents. Rewriting on
    // every read raced with GUI restarts and could truncate the file to 0 bytes.
    if (raw.replace(/\r\n/g, '\n').trimEnd() !== serialized.replace(/\r\n/g, '\n').trimEnd()) {
      try {
        atomicWriteFile(file, serialized);
      } catch {
        /* ignore read-only fs, etc. */
      }
    }
    return next;
  } catch {
    return { configs: [] };
  }
}

export function writeBridgeConfigs(configs: PersistedBridgeConfigs, homeDir?: string): void {
  const file = getBridgeConfigsPath(homeDir);
  atomicWriteFile(file, serializeBridgeConfigs(configs));
}

export function addBridgeConfig(config: PersistedBridgeConfig, homeDir?: string): PersistedBridgeConfigs {
  const current = readBridgeConfigs(homeDir);
  const without = current.configs.filter((c) => c.name !== config.name);
  without.push(config);
  const next = { configs: without };
  writeBridgeConfigs(next, homeDir);
  return next;
}

export function removeBridgeConfig(name: string, homeDir?: string): PersistedBridgeConfigs {
  const current = readBridgeConfigs(homeDir);
  const next = { configs: current.configs.filter((c) => c.name !== name) };
  writeBridgeConfigs(next, homeDir);
  return next;
}

export function findBridgeConfig(name: string, homeDir?: string): PersistedBridgeConfig | undefined {
  return readBridgeConfigs(homeDir).configs.find((c) => c.name === name);
}

/** Build per-run environment overrides for an external CLI process. */
export function buildConfigEnv(config: PersistedBridgeConfig): Record<string, string> {
  if ((config.execution ?? 'api') !== 'cli' || (config.authSource ?? 'native') !== 'apiKey') {
    return {};
  }

  const env: Record<string, string> = {};
  const setIf = (key: string, value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  };
  const modelProvider = config.model?.includes('/')
    ? config.model.slice(0, config.model.indexOf('/')).toLowerCase()
    : undefined;
  const credentialProvider = config.credentialProvider?.toLowerCase() ?? modelProvider;
  const credentialEnv = ({
    anthropic: 'ANTHROPIC_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    codex: 'OPENAI_API_KEY',
    'openai-codex': 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    google: 'GEMINI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
  } as Record<string, string>)[credentialProvider ?? ''];

  switch (config.runtime) {
    case 'claude':
      setIf('ANTHROPIC_API_KEY', config.apiKey);
      setIf('ANTHROPIC_AUTH_TOKEN', config.apiKey);
      setIf('ANTHROPIC_BASE_URL', config.baseURL);
      setIf('ANTHROPIC_MODEL', config.model);
      break;
    case 'codewhale':
      setIf(credentialEnv ?? 'DEEPSEEK_API_KEY', config.apiKey);
      setIf((credentialEnv ?? 'DEEPSEEK_API_KEY').replace(/_API_KEY$/u, '_BASE_URL'), config.baseURL);
      break;
    case 'pi':
      setIf(credentialEnv ?? 'OPENAI_API_KEY', config.apiKey);
      setIf((credentialEnv ?? 'OPENAI_API_KEY').replace(/_API_KEY$/u, '_BASE_URL'), config.baseURL);
      break;
    case 'codex':
      setIf('OPENAI_API_KEY', config.apiKey);
      setIf('OPENAI_BASE_URL', config.baseURL);
      break;
    case 'reasonix':
      setIf(credentialEnv ?? 'DEEPSEEK_API_KEY', config.apiKey);
      setIf((credentialEnv ?? 'DEEPSEEK_API_KEY').replace(/_API_KEY$/u, '_BASE_URL'), config.baseURL);
      break;
    case 'crush': {
      const crushCredential = `CRUSH_${credentialEnv ?? 'OPENAI_API_KEY'}`;
      setIf(crushCredential, config.apiKey);
      setIf(crushCredential.replace(/_API_KEY$/u, '_BASE_URL'), config.baseURL);
      break;
    }
    default:
      break;
  }
  return env;
}

/** Mask an API key for display: first 4 + ellipsis + last 4. */
export function maskApiKey(rawKey: string | undefined): string {
  const key = rawKey ?? '';
  if (!key) return '(none)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
