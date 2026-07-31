import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  hasMediaGenSecret,
  isMediaGenPluginId,
  kindForPluginId,
  mergeMediaProfiles,
  publicMediaProfiles,
  serializeMediaProfiles,
  type MediaGenKind,
  type MediaGenPluginId,
} from './mediaGenProfiles.js';

export const MANAGED_PLUGIN_IDS = [
  'ocr',
  'computer-use',
  'github',
  'kimi-webbridge',
  'playwright',
  'tavily',
  'exa',
  'image-gen',
  'video-gen',
  'mesh-gen',
] as const;

export type ManagedPluginId = typeof MANAGED_PLUGIN_IDS[number];
export type ManagedPluginState =
  | 'available'
  | 'needs-setup'
  | 'ready'
  | 'disabled'
  | 'degraded';

export interface ManagedPluginDefinition {
  id: ManagedPluginId;
  name: string;
  description: string;
  category: 'Featured' | 'Vision' | 'Developer' | 'Browser automation' | 'Search' | 'Media';
  featured: boolean;
}

export interface ManagedPluginHealth {
  state: Exclude<ManagedPluginState, 'available' | 'disabled'>;
  detail?: string;
}

export interface ManagedPluginCatalogOptions {
  health?: Partial<Record<ManagedPluginId, ManagedPluginHealth>>;
}

export interface ManagedPluginCatalogEntry extends ManagedPluginDefinition {
  enabled: boolean;
  state: ManagedPluginState;
  statusDetail?: string;
  secretConfigured: boolean;
  config: Record<string, unknown>;
}

export interface ManagedPluginCatalog {
  plugins: ManagedPluginCatalogEntry[];
  summary: Record<ManagedPluginState, number>;
}

export interface ManagedPluginSettingsPatch {
  enabled?: boolean;
  clearSecret?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export const MANAGED_PLUGIN_DEFINITIONS: readonly ManagedPluginDefinition[] = [
  {
    id: 'ocr',
    name: 'OCR',
    description: 'Extract text and document structure with Qwen and other OCR providers.',
    category: 'Vision',
    featured: true,
  },
  {
    id: 'computer-use',
    name: 'Computer Use',
    description: 'Control desktop applications locally or through an E2B desktop.',
    category: 'Featured',
    featured: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Work with repositories, pull requests, issues, and checks.',
    category: 'Developer',
    featured: true,
  },
  {
    id: 'kimi-webbridge',
    name: 'Kimi WebBridge',
    description: 'Reuse a signed-in browser through the local Kimi WebBridge daemon.',
    category: 'Browser automation',
    featured: false,
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Navigate, inspect, and interact with web pages in a controlled browser.',
    category: 'Browser automation',
    featured: true,
  },
  {
    id: 'tavily',
    name: 'Tavily Search',
    description: 'AI-optimized web search with answers, domain filters, and news depth.',
    category: 'Search',
    featured: true,
  },
  {
    id: 'exa',
    name: 'Exa Search',
    description: 'Neural web search from exa.ai for research papers, companies, and deep discovery.',
    category: 'Search',
    featured: true,
  },
  {
    id: 'image-gen',
    name: 'Image Generation',
    description:
      'Generate images with Gemini Nano Banana, GPT Image 2, and Qwen-Image. Configure multiple models and keys; the agent picks one per request.',
    category: 'Vision',
    featured: true,
  },
  {
    id: 'video-gen',
    name: 'Video Generation',
    description:
      'Generate videos with Seedance, Hailuo, and HappyHorse. Configure multiple models and keys; the agent picks one per request.',
    category: 'Media',
    featured: true,
  },
  {
    id: 'mesh-gen',
    name: '3D Generation',
    description:
      'Generate 3D meshes with Meshy, Tripo, and Rodin. Configure multiple models and keys; the agent picks one per request.',
    category: 'Media',
    featured: true,
  },
] as const;

type ConfigFieldKind = 'string' | 'number' | 'boolean' | 'string-array' | 'profiles';

interface ConfigFieldSpec {
  kind: ConfigFieldKind;
  default?: unknown;
  values?: readonly string[];
}

interface ManagedPluginSpec {
  fields: Record<string, ConfigFieldSpec>;
  secretField?: 'apiKey' | 'token' | 'e2bApiKey';
  /** Per-profile apiKey secrets instead of a single top-level secretField. */
  profileSecrets?: boolean;
  mediaKind?: MediaGenKind;
}

const MEDIA_COMMON_FIELDS: Record<string, ConfigFieldSpec> = {
  defaultProfileId: { kind: 'string' },
  timeoutMs: { kind: 'number', default: 120_000 },
  pollIntervalMs: { kind: 'number', default: 3_000 },
  maxWaitMs: { kind: 'number', default: 900_000 },
  profiles: { kind: 'profiles', default: [] },
};

const PLUGIN_SPECS: Record<ManagedPluginId, ManagedPluginSpec> = {
  ocr: {
    secretField: 'apiKey',
    fields: {
      provider: {
        kind: 'string',
        default: 'qwen',
        values: ['qwen', 'openai-compatible', 'mistral'],
      },
      api: {
        kind: 'string',
        default: 'chat-completions',
        values: ['chat-completions', 'responses'],
      },
      baseURL: {
        kind: 'string',
        default: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      model: { kind: 'string', default: 'qwen3.5-ocr' },
      prompt: { kind: 'string' },
      timeoutMs: { kind: 'number', default: 60_000 },
    },
  },
  'computer-use': {
    secretField: 'e2bApiKey',
    fields: {
      backend: {
        kind: 'string',
        default: 'local',
        values: ['local', 'e2b'],
      },
      e2bTemplate: { kind: 'string' },
      resolutionWidth: { kind: 'number', default: 1440 },
      resolutionHeight: { kind: 'number', default: 900 },
      dpi: { kind: 'number', default: 96 },
      timeoutMs: { kind: 'number', default: 120_000 },
    },
  },
  github: {
    secretField: 'token',
    fields: {
      hostname: { kind: 'string', default: 'github.com' },
      defaultOwner: { kind: 'string' },
      timeoutMs: { kind: 'number', default: 30_000 },
    },
  },
  'kimi-webbridge': {
    fields: {
      daemonUrl: { kind: 'string', default: 'http://127.0.0.1:10086' },
      sessionName: { kind: 'string', default: 'hadamard' },
      timeoutMs: { kind: 'number', default: 30_000 },
      autoStart: { kind: 'boolean', default: true },
    },
  },
  playwright: {
    fields: {
      headless: { kind: 'boolean', default: true },
      channel: {
        kind: 'string',
        default: 'chromium',
        values: ['chromium', 'chrome', 'msedge'],
      },
      cdpUrl: { kind: 'string' },
      userDataDir: { kind: 'string' },
      allowedDomains: { kind: 'string-array' },
      defaultTimeoutMs: { kind: 'number', default: 30_000 },
      allowEvaluate: { kind: 'boolean', default: false },
    },
  },
  tavily: {
    secretField: 'apiKey',
    fields: {
      timeoutMs: { kind: 'number', default: 30_000 },
    },
  },
  exa: {
    secretField: 'apiKey',
    fields: {
      timeoutMs: { kind: 'number', default: 30_000 },
    },
  },
  'image-gen': {
    profileSecrets: true,
    mediaKind: 'image',
    fields: { ...MEDIA_COMMON_FIELDS, timeoutMs: { kind: 'number', default: 180_000 } },
  },
  'video-gen': {
    profileSecrets: true,
    mediaKind: 'video',
    fields: { ...MEDIA_COMMON_FIELDS, timeoutMs: { kind: 'number', default: 120_000 } },
  },
  'mesh-gen': {
    profileSecrets: true,
    mediaKind: 'mesh',
    fields: { ...MEDIA_COMMON_FIELDS, timeoutMs: { kind: 'number', default: 120_000 } },
  },
};

export function readManagedPluginCatalog(
  raw: Record<string, unknown> | null | undefined,
  options: ManagedPluginCatalogOptions = {},
): ManagedPluginCatalog {
  const source = isRecord(raw) ? raw : {};
  const plugins = MANAGED_PLUGIN_DEFINITIONS.map(definition => {
    const config = readStoredManagedPluginConfig(source, definition.id);
    const present = hasStoredPluginEntry(source, definition.id);
    const enabled = config.enabled === true;
    const spec = PLUGIN_SPECS[definition.id];
    const secretConfigured = resolveSecretConfigured(definition.id, config, spec);
    const health = options.health?.[definition.id];
    const state = resolveState(
      definition.id,
      config,
      present,
      enabled,
      secretConfigured,
      health,
    );
    return {
      ...definition,
      enabled,
      state,
      ...(health?.detail ? { statusDetail: health.detail } : {}),
      secretConfigured,
      config: publicConfig(definition.id, config),
    };
  });
  const summary: Record<ManagedPluginState, number> = {
    available: 0,
    'needs-setup': 0,
    ready: 0,
    disabled: 0,
    degraded: 0,
  };
  for (const plugin of plugins) summary[plugin.state] += 1;
  return { plugins, summary };
}

/**
 * Read the server-side runtime configuration, including its credential.
 * Do not serialize this value into GUI or other untrusted responses.
 */
export function readStoredManagedPluginConfig(
  raw: Record<string, unknown> | null | undefined,
  pluginId: ManagedPluginId,
): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  const managed = isRecord(source.managedPlugins) ? source.managedPlugins : {};
  const managedEntry = isRecord(managed[pluginId]) ? managed[pluginId] : {};
  const legacyBrowser = pluginId === 'playwright' && isRecord(source.browser)
    ? source.browser
    : {};
  const combined = pluginId === 'playwright'
    ? { ...legacyBrowser, ...managedEntry }
    : managedEntry;
  const result: Record<string, unknown> = {};
  if (typeof combined.enabled === 'boolean') result.enabled = combined.enabled;
  const spec = PLUGIN_SPECS[pluginId];
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    if (fieldSpec.kind === 'profiles') {
      const kind = spec.mediaKind!;
      result.profiles = serializeMediaProfiles(
        mergeMediaProfiles(undefined, combined.profiles, kind),
      );
      continue;
    }
    const normalized = normalizeFieldValue(field, combined[field], fieldSpec, false);
    if (normalized !== undefined) result[field] = normalized;
    else if (fieldSpec.default !== undefined) result[field] = cloneDefault(fieldSpec.default);
  }
  if (spec.secretField) {
    const secret = combined[spec.secretField];
    if (typeof secret === 'string' && secret.trim()) {
      result[spec.secretField] = secret.trim();
    }
  }
  return result;
}

/**
 * Apply a GUI/TUI patch in place. Empty credential inputs intentionally retain
 * the previous value; callers must set clearSecret to remove it.
 */
export function patchManagedPluginSettings(
  raw: Record<string, unknown>,
  pluginId: ManagedPluginId,
  patch: ManagedPluginSettingsPatch,
): Record<string, unknown> {
  assertManagedPluginId(pluginId);
  const current = readStoredManagedPluginConfig(raw, pluginId);
  const next: Record<string, unknown> = { ...current };
  const values = isRecord(patch.config)
    ? { ...patch.config, ...patch }
    : patch;
  delete next.config;
  delete next.clearSecret;

  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  const spec = PLUGIN_SPECS[pluginId];
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    if (fieldSpec.kind === 'profiles') {
      if (!Object.hasOwn(values, 'profiles') && patch.clearSecret !== true) continue;
      const kind = spec.mediaKind!;
      const merged = mergeMediaProfiles(
        current.profiles,
        Object.hasOwn(values, 'profiles') ? values.profiles : current.profiles,
        kind,
        { clearSecrets: patch.clearSecret === true },
      );
      next.profiles = serializeMediaProfiles(merged);
      continue;
    }
    if (!Object.hasOwn(values, field)) continue;
    const normalized = normalizeFieldValue(field, values[field], fieldSpec, true);
    if (normalized === undefined) delete next[field];
    else next[field] = normalized;
  }

  if (spec.secretField) {
    if (patch.clearSecret === true) {
      delete next[spec.secretField];
    } else if (Object.hasOwn(values, spec.secretField)) {
      const secret = values[spec.secretField];
      if (typeof secret !== 'string') {
        throw new Error(`${spec.secretField} must be a string.`);
      }
      if (secret.trim()) next[spec.secretField] = secret.trim();
    }
  }

  const managed = isRecord(raw.managedPlugins)
    ? { ...raw.managedPlugins }
    : {};
  managed[pluginId] = next;
  raw.managedPlugins = managed;

  if (pluginId === 'playwright') {
    const browser = isRecord(raw.browser) ? { ...raw.browser } : {};
    if (typeof next.enabled === 'boolean') browser.enabled = next.enabled;
    for (const field of Object.keys(spec.fields)) {
      if (Object.hasOwn(next, field)) browser[field] = cloneDefault(next[field]);
      else delete browser[field];
    }
    raw.browser = browser;
  }

  return raw;
}

function resolveSecretConfigured(
  pluginId: ManagedPluginId,
  config: Record<string, unknown>,
  spec: ManagedPluginSpec,
): boolean {
  if (spec.profileSecrets && spec.mediaKind) {
    return hasMediaGenSecret(config, spec.mediaKind);
  }
  const secret = spec.secretField ? config[spec.secretField] : undefined;
  return Boolean(typeof secret === 'string' && secret.trim());
}

function publicConfig(
  pluginId: ManagedPluginId,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const spec = PLUGIN_SPECS[pluginId];
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    if (fieldSpec.kind === 'profiles' && spec.mediaKind) {
      config.profiles = publicMediaProfiles(stored.profiles, spec.mediaKind);
      continue;
    }
    if (Object.hasOwn(stored, field)) config[field] = cloneDefault(stored[field]);
  }
  return config;
}

function resolveState(
  pluginId: ManagedPluginId,
  config: Record<string, unknown>,
  present: boolean,
  enabled: boolean,
  secretConfigured: boolean,
  health: ManagedPluginHealth | undefined,
): ManagedPluginState {
  if (!present) return 'available';
  if (!enabled) return 'disabled';
  if (pluginId === 'ocr' && !secretConfigured) return 'needs-setup';
  if (
    pluginId === 'computer-use'
    && config.backend === 'e2b'
    && !secretConfigured
  ) return 'needs-setup';
  // GitHub can reuse the account stored by `gh auth login`; an alternate
  // token is optional. A health probe can still mark the integration degraded.
  if (pluginId === 'github' && !secretConfigured) return health?.state ?? 'ready';
  // Tavily/Exa accept plugin apiKey, env vars, or ~/.tavily|~/.exa config files.
  if ((pluginId === 'tavily' || pluginId === 'exa') && !secretConfigured) {
    return hasExternalSearchCredential(pluginId)
      ? (health?.state ?? 'ready')
      : 'needs-setup';
  }
  if (isMediaGenPluginId(pluginId) && !secretConfigured) return 'needs-setup';
  return health?.state ?? 'ready';
}

function hasExternalSearchCredential(pluginId: 'tavily' | 'exa'): boolean {
  if (pluginId === 'tavily') {
    if (process.env.TAVILY_API_KEY?.trim()) return true;
    return readJsonApiKey(path.join(homedir(), '.tavily', 'config.json')) != null;
  }
  if (process.env.EXA_API_KEY?.trim()) return true;
  return readJsonApiKey(path.join(homedir(), '.exa', 'config.json')) != null;
}

function readJsonApiKey(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      api_key?: unknown;
      apiKey?: unknown;
    };
    const key = typeof parsed.api_key === 'string'
      ? parsed.api_key.trim()
      : typeof parsed.apiKey === 'string'
        ? parsed.apiKey.trim()
        : '';
    return key || undefined;
  } catch {
    return undefined;
  }
}

function hasStoredPluginEntry(
  raw: Record<string, unknown>,
  pluginId: ManagedPluginId,
): boolean {
  if (isRecord(raw.managedPlugins) && isRecord(raw.managedPlugins[pluginId])) return true;
  return pluginId === 'playwright'
    && isRecord(raw.browser)
    && typeof raw.browser.enabled === 'boolean';
}

function normalizeFieldValue(
  field: string,
  value: unknown,
  spec: ConfigFieldSpec,
  strict: boolean,
): unknown {
  if (spec.kind === 'profiles') return undefined;
  if (value === undefined || value === null) return undefined;
  if (spec.kind === 'string') {
    if (typeof value !== 'string') {
      if (strict) throw new Error(`${field} must be a string.`);
      return undefined;
    }
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (spec.values && !spec.values.includes(normalized)) {
      if (strict) throw new Error(`${field} must be one of: ${spec.values.join(', ')}.`);
      return undefined;
    }
    return normalized;
  }
  if (spec.kind === 'number') {
    const normalized = typeof value === 'string' && value.trim()
      ? Number(value)
      : value;
    if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized <= 0) {
      if (strict) throw new Error(`${field} must be a positive number.`);
      return undefined;
    }
    return Math.trunc(normalized);
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      if (strict) throw new Error(`${field} must be a boolean.`);
      return undefined;
    }
    return value;
  }
  const items = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value)
      ? value
      : undefined;
  if (!items) {
    if (strict) throw new Error(`${field} must be a string array.`);
    return undefined;
  }
  return [...new Set(items
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

function assertManagedPluginId(value: string): asserts value is ManagedPluginId {
  if (!(MANAGED_PLUGIN_IDS as readonly string[]).includes(value)) {
    throw new Error(`Unknown managed plugin: ${value}`);
  }
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => cloneDefault(item));
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = cloneDefault(entry);
    return next;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { MediaGenPluginId };
export { kindForPluginId, isMediaGenPluginId };
