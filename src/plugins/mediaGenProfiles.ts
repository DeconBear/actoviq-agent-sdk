import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type MediaGenKind = 'image' | 'video' | 'mesh';

export type ImageGenProvider = 'gemini' | 'openai' | 'dashscope';
export type VideoGenProvider = 'seedance' | 'hailuo' | 'happyhorse';
export type MeshGenProvider = 'meshy' | 'tripo' | 'rodin';
export type MediaGenProvider = ImageGenProvider | VideoGenProvider | MeshGenProvider;

export interface MediaGenProfile {
  id: string;
  label?: string;
  provider: MediaGenProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
  enabled?: boolean;
}

export interface MediaGenPluginConfig {
  enabled?: boolean;
  defaultProfileId?: string;
  profiles: MediaGenProfile[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export const MEDIA_GEN_PLUGIN_IDS = ['image-gen', 'video-gen', 'mesh-gen'] as const;
export type MediaGenPluginId = (typeof MEDIA_GEN_PLUGIN_IDS)[number];

export const MEDIA_GEN_PROVIDER_LINKS: Record<MediaGenProvider, {
  apiKeyUrl: string;
  docsUrl: string;
  label: string;
}> = {
  gemini: {
    label: 'Google AI Studio',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
  },
  openai: {
    label: 'OpenAI',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
  },
  dashscope: {
    label: 'Alibaba DashScope / Model Studio',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-api',
  },
  seedance: {
    label: 'Volcengine Ark (Seedance)',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    docsUrl: 'https://www.volcengine.com/docs/82379/1520757',
  },
  hailuo: {
    label: 'MiniMax Hailuo',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimaxi.com/document/video_generation',
  },
  happyhorse: {
    label: 'Alibaba DashScope (HappyHorse)',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference',
  },
  meshy: {
    label: 'Meshy',
    apiKeyUrl: 'https://www.meshy.ai/api',
    docsUrl: 'https://docs.meshy.ai/api/text-to-3d',
  },
  tripo: {
    label: 'Tripo3D',
    apiKeyUrl: 'https://platform.tripo3d.ai/',
    docsUrl: 'https://platform.tripo3d.ai/docs/generation',
  },
  rodin: {
    label: 'Hyper3D Rodin',
    apiKeyUrl: 'https://hyper3d.ai/',
    docsUrl: 'https://developer.hyper3d.ai/',
  },
};

export const DEFAULT_MEDIA_BASE_URLS: Record<MediaGenProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
  dashscope: 'https://dashscope.aliyuncs.com/api/v1',
  seedance: 'https://ark.cn-beijing.volces.com/api/v3',
  hailuo: 'https://api.minimax.chat/v1',
  happyhorse: 'https://dashscope.aliyuncs.com/api/v1',
  meshy: 'https://api.meshy.ai',
  tripo: 'https://api.tripo3d.ai',
  rodin: 'https://api.hyper3d.com',
};

export const DEFAULT_MEDIA_MODELS: Record<MediaGenProvider, string> = {
  gemini: 'gemini-2.0-flash-preview-image-generation',
  openai: 'gpt-image-2',
  dashscope: 'qwen-image-3.0-pro',
  seedance: 'doubao-seedance-1-5-pro-251215',
  hailuo: 'MiniMax-Hailuo-02',
  happyhorse: 'happyhorse-1.1-t2v',
  meshy: 'latest',
  tripo: 'turbo_v1.5-20260123',
  rodin: 'rodin',
};

const IMAGE_PROVIDERS = new Set<string>(['gemini', 'openai', 'dashscope']);
const VIDEO_PROVIDERS = new Set<string>(['seedance', 'hailuo', 'happyhorse']);
const MESH_PROVIDERS = new Set<string>(['meshy', 'tripo', 'rodin']);

export function isMediaGenPluginId(value: string): value is MediaGenPluginId {
  return (MEDIA_GEN_PLUGIN_IDS as readonly string[]).includes(value);
}

export function providersForKind(kind: MediaGenKind): readonly MediaGenProvider[] {
  if (kind === 'image') return ['gemini', 'openai', 'dashscope'];
  if (kind === 'video') return ['seedance', 'hailuo', 'happyhorse'];
  return ['meshy', 'tripo', 'rodin'];
}

export function kindForPluginId(pluginId: MediaGenPluginId): MediaGenKind {
  if (pluginId === 'image-gen') return 'image';
  if (pluginId === 'video-gen') return 'video';
  return 'mesh';
}

export function parseMediaGenProfiles(
  raw: unknown,
  kind: MediaGenKind,
  options: { requireApiKey?: boolean } = {},
): MediaGenProfile[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(providersForKind(kind));
  const out: MediaGenProfile[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    const provider = stringValue(item.provider);
    if (!id || !allowed.has(provider)) continue;
    const apiKey = stringValue(item.apiKey);
    if (options.requireApiKey && !apiKey) continue;
    const model = stringValue(item.model) || DEFAULT_MEDIA_MODELS[provider as MediaGenProvider];
    const profile: MediaGenProfile = {
      id,
      provider: provider as MediaGenProvider,
      model,
      apiKey,
    };
    const label = stringValue(item.label);
    if (label) profile.label = label;
    const baseURL = stringValue(item.baseURL) || stringValue(item.baseUrl);
    if (baseURL) profile.baseURL = baseURL;
    if (item.enabled === false) profile.enabled = false;
    out.push(profile);
  }
  return out;
}

export function availableMediaProfiles(
  config: Record<string, unknown>,
  kind: MediaGenKind,
): MediaGenProfile[] {
  return parseMediaGenProfiles(config.profiles, kind, { requireApiKey: true })
    .filter(profile => profile.enabled !== false && profile.apiKey.trim());
}

export function hasMediaGenSecret(config: Record<string, unknown>, kind: MediaGenKind): boolean {
  return availableMediaProfiles(config, kind).length > 0;
}

export function selectMediaProfile(
  profiles: MediaGenProfile[],
  selector: string | undefined,
  defaultProfileId?: string,
): MediaGenProfile {
  const usable = profiles.filter(p => p.enabled !== false && p.apiKey.trim());
  if (usable.length === 0) {
    throw new Error('No media generation profiles with API keys are configured.');
  }
  if (selector?.trim()) {
    const needle = selector.trim().toLowerCase();
    const match = usable.find(profile =>
      profile.id.toLowerCase() === needle
      || profile.label?.toLowerCase() === needle
      || profile.model.toLowerCase() === needle
      || profile.provider.toLowerCase() === needle,
    );
    if (!match) {
      throw new Error(
        `Unknown media profile "${selector}". Available: ${usable.map(p => p.id).join(', ')}`,
      );
    }
    return match;
  }
  if (defaultProfileId?.trim()) {
    const preferred = usable.find(p => p.id === defaultProfileId.trim());
    if (preferred) return preferred;
  }
  return usable[0]!;
}

export function resolveProfileBaseUrl(profile: MediaGenProfile): string {
  return (profile.baseURL?.trim() || DEFAULT_MEDIA_BASE_URLS[profile.provider]).replace(/\/+$/u, '');
}

/** Public DTO: strip apiKey, expose per-profile secretConfigured. */
export function publicMediaProfiles(
  raw: unknown,
  kind: MediaGenKind,
): Array<Record<string, unknown>> {
  const profiles = parseMediaGenProfiles(raw, kind);
  return profiles.map(profile => {
    const entry: Record<string, unknown> = {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
      secretConfigured: Boolean(profile.apiKey.trim()),
    };
    if (profile.label) entry.label = profile.label;
    if (profile.baseURL) entry.baseURL = profile.baseURL;
    if (profile.enabled === false) entry.enabled = false;
    return entry;
  });
}

/**
 * Merge incoming profiles with previous ones: empty apiKey keeps the prior key
 * for the same profile id.
 */
export function mergeMediaProfiles(
  previous: unknown,
  incoming: unknown,
  kind: MediaGenKind,
  options: { clearSecrets?: boolean } = {},
): MediaGenProfile[] {
  const prev = parseMediaGenProfiles(previous, kind);
  const prevById = new Map(prev.map(p => [p.id, p]));
  if (!Array.isArray(incoming)) {
    if (options.clearSecrets) {
      return prev.map(p => ({ ...p, apiKey: '' }));
    }
    return prev;
  }
  const next = parseMediaGenProfiles(incoming, kind);
  return next.map(profile => {
    const prior = prevById.get(profile.id);
    let apiKey = profile.apiKey;
    if (!apiKey && prior?.apiKey && !options.clearSecrets) {
      apiKey = prior.apiKey;
    }
    if (options.clearSecrets) apiKey = '';
    return { ...profile, apiKey };
  });
}

export function serializeMediaProfiles(profiles: MediaGenProfile[]): Array<Record<string, unknown>> {
  return profiles.map(profile => {
    const entry: Record<string, unknown> = {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
    };
    if (profile.label) entry.label = profile.label;
    if (profile.baseURL) entry.baseURL = profile.baseURL;
    if (profile.enabled === false) entry.enabled = false;
    if (profile.apiKey.trim()) entry.apiKey = profile.apiKey.trim();
    return entry;
  });
}

export function assertProviderKind(
  provider: string,
  kind: MediaGenKind,
): asserts provider is MediaGenProvider {
  const ok = kind === 'image'
    ? IMAGE_PROVIDERS.has(provider)
    : kind === 'video'
      ? VIDEO_PROVIDERS.has(provider)
      : MESH_PROVIDERS.has(provider);
  if (!ok) {
    throw new Error(`Provider "${provider}" is not valid for ${kind} generation.`);
  }
}

export type MediaGenFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function pollUntil<T>(
  options: {
    intervalMs: number;
    maxWaitMs: number;
    signal?: AbortSignal;
    tick: () => Promise<{ done: boolean; value?: T; failed?: string }>;
  },
): Promise<T> {
  const started = Date.now();
  while (true) {
    if (options.signal?.aborted) {
      throw new Error('Media generation aborted.');
    }
    const result = await options.tick();
    if (result.failed) throw new Error(result.failed);
    if (result.done) {
      if (result.value === undefined) throw new Error('Media generation completed without a result.');
      return result.value;
    }
    if (Date.now() - started > options.maxWaitMs) {
      throw new Error(`Media generation timed out after ${options.maxWaitMs}ms.`);
    }
    await sleep(options.intervalMs, options.signal);
  }
}

export async function writeGeneratedArtifact(
  cwd: string,
  kind: MediaGenKind,
  filename: string,
  data: Buffer | Uint8Array,
  outputPath?: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const folder = kind === 'mesh' ? 'meshes' : `${kind}s`;
  const relative = outputPath?.trim()
    || path.join('.actoviq', 'generated', folder, filename);
  const absolute = path.resolve(cwd, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  return { absolutePath: absolute, relativePath: relative.replace(/\\/g, '/') };
}

export async function downloadBinary(
  url: string,
  fetchImpl: MediaGenFetch,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<Buffer> {
  const response = await fetchImpl(url, { method: 'GET', headers, signal });
  if (!response.ok) {
    throw new Error(`Failed to download artifact (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Media generation aborted.'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Media generation aborted.'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
