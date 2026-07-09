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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function readBridgeConfigs(homeDir?: string): PersistedBridgeConfigs {
  const file = getBridgeConfigsPath(homeDir);
  if (!existsSync(file)) return { configs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const configs = Array.isArray(parsed.configs)
      ? parsed.configs.filter(isValidConfig).map((c: PersistedBridgeConfig) => {
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
        })
      : [];
    // Best-effort re-save: write the migrated configs back so the file stays
    // current. Ignore failures (read-only fs, etc.).
    try { writeFileSync(file, JSON.stringify({ configs }, null, 2), 'utf-8'); } catch { /* ignore */ }
    return { configs };
  } catch {
    return { configs: [] };
  }
}

export function writeBridgeConfigs(configs: PersistedBridgeConfigs, homeDir?: string): void {
  const file = getBridgeConfigsPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(configs, null, 2), 'utf-8');
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
