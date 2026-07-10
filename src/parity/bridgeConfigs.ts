/**
 * Named bridge connection configs (apiKey + baseURL presets).
 *
 * Persisted to ~/.actoviq/bridge-configs.json. Each config bundles a provider
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
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveActoviqHome } from '../config/actoviqHome.js';

export type InProcessProvider = 'anthropic' | 'openai';

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
  /** Text-only or multimodal (vision). */
  modality?: ModelModality;
}

export interface PersistedBridgeConfig {
  name: string;
  /** Runtime: 'hadamard' uses the SDK's default provider/credentials;
   *  'bridge' uses this config's provider/apiKey/baseURL. */
  runtime: BridgeRuntime;
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
  return path.join(resolveActoviqHome(homeDir), 'bridge-configs.json');
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
  const out: PersistedBridgeConfig = {
    name: c.name,
    provider: migrateProvider(c.provider),
    // Pre-v0.8 legacy: missing/unknown runtime defaults to 'claude'.
    runtime: isValidRuntime(c.runtime) ? c.runtime : 'claude',
  };
  if (typeof c.apiKey === 'string' && c.apiKey) out.apiKey = c.apiKey;
  if (typeof c.baseURL === 'string' && c.baseURL) out.baseURL = c.baseURL;
  if (typeof c.model === 'string' && c.model) out.model = c.model;
  if (Array.isArray(c.models)) {
    out.models = c.models.filter(
      (m: unknown): m is ProviderModelEntry =>
        typeof m === 'object' && m !== null && typeof (m as ProviderModelEntry).name === 'string',
    );
  }
  return out;
}

function serializeBridgeConfigs(configs: PersistedBridgeConfigs): string {
  return `${JSON.stringify(configs, null, 2)}\n`;
}

/** Write via temp+rename so a crash mid-write cannot leave a 0-byte configs file. */
function atomicWriteFile(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf-8');
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
}

export function readBridgeConfigs(homeDir?: string): PersistedBridgeConfigs {
  const file = getBridgeConfigsPath(homeDir);
  if (!existsSync(file)) return { configs: [] };
  try {
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

/** Mask an API key for display: first 4 + ellipsis + last 4. */
export function maskApiKey(rawKey: string | undefined): string {
  const key = rawKey ?? '';
  if (!key) return '(none)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
