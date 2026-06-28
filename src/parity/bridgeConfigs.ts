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
import os from 'node:os';
import path from 'node:path';

export type InProcessProvider = 'anthropic' | 'openai';

export interface PersistedBridgeConfig {
  name: string;
  provider: InProcessProvider;
  apiKey?: string;
  baseURL?: string;
  model?: string;
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
  reasonix: 'anthropic',
  crush: 'openai',
};

function migrateProvider(raw: string): InProcessProvider {
  if ((VALID_PROVIDERS as string[]).includes(raw)) return raw as InProcessProvider;
  return LEGACY_PROVIDER_MIGRATION[raw] ?? 'anthropic'; // fallback safe: unknown → anthropic
}

export function getBridgeConfigsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.actoviq', 'bridge-configs.json');
}

function isValidConfig(value: unknown): value is PersistedBridgeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === 'string' && typeof c.provider === 'string';
}

export function readBridgeConfigs(homeDir: string = os.homedir()): PersistedBridgeConfigs {
  const file = getBridgeConfigsPath(homeDir);
  if (!existsSync(file)) return { configs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const configs = Array.isArray(parsed.configs)
      ? parsed.configs.filter(isValidConfig).map((c: PersistedBridgeConfig) => {
          const out: PersistedBridgeConfig = {
            name: c.name,
            provider: migrateProvider(c.provider),
          };
          if (typeof c.apiKey === 'string' && c.apiKey) out.apiKey = c.apiKey;
          if (typeof c.baseURL === 'string' && c.baseURL) out.baseURL = c.baseURL;
          if (typeof c.model === 'string' && c.model) out.model = c.model;
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

export function writeBridgeConfigs(configs: PersistedBridgeConfigs, homeDir: string = os.homedir()): void {
  const file = getBridgeConfigsPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(configs, null, 2), 'utf-8');
}

export function addBridgeConfig(config: PersistedBridgeConfig, homeDir: string = os.homedir()): PersistedBridgeConfigs {
  const current = readBridgeConfigs(homeDir);
  const without = current.configs.filter((c) => c.name !== config.name);
  without.push(config);
  const next = { configs: without };
  writeBridgeConfigs(next, homeDir);
  return next;
}

export function removeBridgeConfig(name: string, homeDir: string = os.homedir()): PersistedBridgeConfigs {
  const current = readBridgeConfigs(homeDir);
  const next = { configs: current.configs.filter((c) => c.name !== name) };
  writeBridgeConfigs(next, homeDir);
  return next;
}

export function findBridgeConfig(name: string, homeDir: string = os.homedir()): PersistedBridgeConfig | undefined {
  return readBridgeConfigs(homeDir).configs.find((c) => c.name === name);
}

/** Mask an API key for display: first 4 + … + last 4. */
export function maskApiKey(key: string | undefined): string {
  if (!key) return '(none)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
