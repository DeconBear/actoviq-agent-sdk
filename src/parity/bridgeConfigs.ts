/**
 * Named bridge connection configs (apiKey + baseURL presets).
 *
 * A persisted list of named connection profiles the user adds from the TUI
 * (`/bridge config`), stored at ~/.actoviq/bridge-configs.json. Each config
 * bundles a runtime provider plus the credentials that provider's CLI reads,
 * so the user can pre-configure e.g. one claude runtime pointed at DeepSeek
 * and another at Qwen, and switch between them by name.
 *
 * At activation the TUI injects the config's credentials into each bridge run
 * via the per-run `env` option, which flows through to the child process
 * (buildChildEnvironment → provider.buildChildEnv overrides, spread LAST) and
 * overrides whatever ~/.actoviq/settings.json supplies. Mirrors mcpServerConfig.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeProviderId } from '../types.js';

export interface PersistedBridgeConfig {
  name: string;
  provider: RuntimeProviderId;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface PersistedBridgeConfigs {
  configs: PersistedBridgeConfig[];
}

const VALID_PROVIDERS: RuntimeProviderId[] = ['claude', 'pi', 'codex', 'codewhale', 'reasonix', 'crush'];

export function getBridgeConfigsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.actoviq', 'bridge-configs.json');
}

function isValidConfig(value: unknown): value is PersistedBridgeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    typeof c.provider === 'string' &&
    (VALID_PROVIDERS as string[]).includes(c.provider)
  );
}

export function readBridgeConfigs(homeDir: string = os.homedir()): PersistedBridgeConfigs {
  const file = getBridgeConfigsPath(homeDir);
  if (!existsSync(file)) return { configs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const configs = Array.isArray(parsed.configs)
      ? parsed.configs.filter(isValidConfig).map((c: PersistedBridgeConfig) => {
          const out: PersistedBridgeConfig = { name: c.name, provider: c.provider };
          if (typeof c.apiKey === 'string' && c.apiKey) out.apiKey = c.apiKey;
          if (typeof c.baseURL === 'string' && c.baseURL) out.baseURL = c.baseURL;
          if (typeof c.model === 'string' && c.model) out.model = c.model;
          return out;
        })
      : [];
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

/**
 * Map a config's credentials to the env vars its provider's CLI reads. These
 * become the per-run `env` overrides (spread LAST in provider.buildChildEnv, so
 * they win over settings.json). Empty fields are omitted so we never clobber an
 * inherited value with nothing.
 */
export function buildConfigEnv(config: PersistedBridgeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const setIf = (key: string, value: string | undefined) => {
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  };
  switch (config.provider) {
    case 'claude':
      // claude maps ACTOVIQ_* → ANTHROPIC_* but our per-run overrides land last;
      // set ANTHROPIC_* directly. ANTHROPIC_AUTH_TOKEN is the bearer form.
      setIf('ANTHROPIC_API_KEY', config.apiKey);
      setIf('ANTHROPIC_AUTH_TOKEN', config.apiKey);
      setIf('ANTHROPIC_BASE_URL', config.baseURL);
      setIf('ANTHROPIC_MODEL', config.model);
      break;
    case 'codewhale':
      // stream-json passthrough, claude-compatible wire format.
      setIf('ANTHROPIC_API_KEY', config.apiKey);
      setIf('ANTHROPIC_BASE_URL', config.baseURL);
      break;
    case 'pi':
      // pi supports OpenAI- and Anthropic-compatible backends; OPENAI_* is the
      // common case. If the baseURL looks anthropic, prefer ANTHROPIC_*.
      if (config.baseURL && /anthropic/i.test(config.baseURL)) {
        setIf('ANTHROPIC_API_KEY', config.apiKey);
        setIf('ANTHROPIC_BASE_URL', config.baseURL);
      } else {
        setIf('OPENAI_API_KEY', config.apiKey);
        setIf('OPENAI_BASE_URL', config.baseURL);
      }
      break;
    case 'codex':
      setIf('OPENAI_API_KEY', config.apiKey);
      setIf('OPENAI_BASE_URL', config.baseURL);
      break;
    case 'crush':
      // multi-backend; OPENAI_API_KEY is the common read.
      setIf('OPENAI_API_KEY', config.apiKey);
      break;
    case 'reasonix':
      setIf('DEEPSEEK_API_KEY', config.apiKey);
      break;
    default:
      break;
  }
  return env;
}

/** Mask an API key for display: first 4 + … + last 4. */
export function maskApiKey(key: string | undefined): string {
  if (!key) return '(none)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
