import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import {
  DEFAULT_VIDEO_NEGATIVE_PROMPT,
  VIDEO_GEN_PROMPT_GUIDANCE,
  formatAvailableProfilesPrompt,
} from './mediaGenPromptGuidance.js';
import {
  asRecord,
  availableMediaProfiles,
  downloadBinary,
  numberValue,
  pollUntil,
  resolveProfileBaseUrl,
  selectMediaProfile,
  stringValue,
  timestampSlug,
  writeGeneratedArtifact,
  type MediaGenFetch,
  type MediaGenProfile,
  type MediaGenPluginConfig,
} from './mediaGenProfiles.js';

export interface VideoGenToolOptions {
  name?: string;
  cwd?: string;
  fetch?: MediaGenFetch;
  config: MediaGenPluginConfig;
}

export interface VideoGenInput {
  prompt: string;
  userIntent?: string;
  negativePrompt?: string;
  profile?: string;
  outputPath?: string;
  duration?: number;
  resolution?: string;
  imagePath?: string;
  promptExtend?: boolean;
}

export interface VideoGenResult {
  profile: string;
  provider: string;
  model: string;
  path: string;
  prompt: string;
  userIntent?: string;
  negativePrompt?: string;
  bytes: number;
  taskId?: string;
}

const inputSchema = z.strictObject({
  prompt: z
    .string()
    .min(1)
    .max(20_000)
    .describe('Professional video-generation prompt (rewritten by the agent).'),
  userIntent: z.string().max(4_000).optional(),
  negativePrompt: z.string().max(2_000).optional(),
  profile: z.string().min(1).optional(),
  outputPath: z.string().min(1).optional(),
  duration: z.number().int().positive().max(30).optional(),
  resolution: z.string().min(1).optional(),
  imagePath: z
    .string()
    .min(1)
    .optional()
    .describe('Optional first-frame image path for i2v (HappyHorse supports this).'),
  promptExtend: z.boolean().optional(),
});

export function createVideoGenTool(
  options: VideoGenToolOptions,
): AgentToolDefinition<VideoGenInput, VideoGenResult> {
  const profiles = availableMediaProfiles(
    { profiles: options.config.profiles },
    'video',
  );
  const profilePrompt = formatAvailableProfilesPrompt(
    profiles,
    options.config.defaultProfileId,
  );

  return tool(
    {
      name: options.name?.trim() || 'generate_video',
      description:
        'Generate a video with a configured Video Generation profile (Seedance, Hailuo, or HappyHorse). Rewrite casual user requests into a professional cinematic prompt before calling.',
      inputSchema,
      isReadOnly: () => false,
      isDestructive: () => false,
      requiresUserInteraction: () => false,
      interruptBehavior: 'cancel',
      getToolUseSummary: input => `Generate video (${input.profile || 'default'})`,
      prompt: () => `${VIDEO_GEN_PROMPT_GUIDANCE}\n\n${profilePrompt}`,
    },
    async (input, context) => {
      const selected = selectMediaProfile(
        profiles,
        input.profile,
        options.config.defaultProfileId,
      );
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('Video generation requires fetch.');
      }
      const cwd = options.cwd ?? context.cwd ?? process.cwd();
      const negative = input.negativePrompt?.trim() || DEFAULT_VIDEO_NEGATIVE_PROMPT;
      const generated = await generateVideoFile(input, negative, selected, {
        cwd,
        fetch: fetchImpl,
        signal: context.signal,
        timeoutMs: options.config.timeoutMs ?? 120_000,
        pollIntervalMs: options.config.pollIntervalMs ?? 3_000,
        maxWaitMs: options.config.maxWaitMs ?? 900_000,
      });
      const filename = `${timestampSlug()}-${selected.id}.mp4`;
      const written = await writeGeneratedArtifact(
        cwd,
        'video',
        filename,
        generated.bytes,
        input.outputPath,
      );
      const result: VideoGenResult = {
        profile: selected.id,
        provider: selected.provider,
        model: selected.model,
        path: written.relativePath,
        prompt: input.prompt,
        bytes: generated.bytes.byteLength,
        negativePrompt: negative,
      };
      if (input.userIntent?.trim()) result.userIntent = input.userIntent.trim();
      if (generated.taskId) result.taskId = generated.taskId;
      return result;
    },
  );
}

async function generateVideoFile(
  input: VideoGenInput,
  negativePrompt: string,
  profile: MediaGenProfile,
  options: {
    cwd: string;
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<{ bytes: Buffer; taskId?: string }> {
  if (profile.provider === 'seedance') {
    return runSeedance(input, profile, options);
  }
  if (profile.provider === 'hailuo') {
    return runHailuo(input, profile, options);
  }
  if (profile.provider === 'happyhorse') {
    return runHappyHorse(input, negativePrompt, profile, options);
  }
  throw new Error(`Unsupported video provider: ${profile.provider}`);
}

async function runSeedance(
  input: VideoGenInput,
  profile: MediaGenProfile,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<{ bytes: Buffer; taskId?: string }> {
  const base = resolveProfileBaseUrl(profile);
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.prompt },
  ];
  const created = await requestJson(
    `${base}/contents/generations/tasks`,
    { model: profile.model, content },
    { Authorization: `Bearer ${profile.apiKey}` },
    options,
  );
  const taskId = stringValue(created.id) || stringValue(asRecord(created.data).id);
  if (!taskId) throw new Error('Seedance did not return a task id.');
  const final = await pollUntil<Record<string, unknown>>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        undefined,
        { Authorization: `Bearer ${profile.apiKey}` },
        { ...options, method: 'GET' },
      );
      const state = stringValue(status.status).toLowerCase();
      if (state === 'succeeded' || state === 'success') {
        return { done: true, value: status };
      }
      if (state === 'failed' || state === 'cancelled' || state === 'canceled') {
        return {
          done: false,
          failed: stringValue(status.error) || `Seedance task ${state}`,
        };
      }
      return { done: false };
    },
  });
  const contentOut = asRecord(final.content);
  const videoUrl = stringValue(contentOut.video_url)
    || stringValue(final.video_url)
    || stringValue(asRecord(final.output).video_url);
  if (!videoUrl) throw new Error('Seedance completed without a video_url.');
  const bytes = await downloadBinary(videoUrl, options.fetch, options.signal);
  return { bytes, taskId };
}

async function runHailuo(
  input: VideoGenInput,
  profile: MediaGenProfile,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<{ bytes: Buffer; taskId?: string }> {
  const base = resolveProfileBaseUrl(profile);
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt: input.prompt,
  };
  if (input.duration) body.duration = input.duration;
  if (input.resolution) body.resolution = input.resolution;
  const created = await requestJson(
    `${base}/video_generation`,
    body,
    { Authorization: `Bearer ${profile.apiKey}` },
    options,
  );
  const taskId = stringValue(created.task_id)
    || stringValue(created.taskId)
    || stringValue(asRecord(created.data).task_id);
  if (!taskId) throw new Error('Hailuo did not return a task_id.');
  const final = await pollUntil<Record<string, unknown>>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
        undefined,
        { Authorization: `Bearer ${profile.apiKey}` },
        { ...options, method: 'GET' },
      );
      const state = stringValue(status.status || status.task_status).toLowerCase();
      if (state === 'success' || state === 'succeeded' || state === 'done') {
        return { done: true, value: status };
      }
      if (state === 'failed' || state === 'fail' || state === 'error') {
        return {
          done: false,
          failed: stringValue(asRecord(status.base_resp).status_msg)
            || stringValue(status.error)
            || `Hailuo task ${state}`,
        };
      }
      return { done: false };
    },
  });
  const fileId = stringValue(final.file_id) || stringValue(asRecord(final.data).file_id);
  const directUrl = stringValue(final.video_url)
    || stringValue(final.file_url)
    || stringValue(asRecord(final.data).download_url);
  if (directUrl) {
    return {
      bytes: await downloadBinary(directUrl, options.fetch, options.signal, {
        Authorization: `Bearer ${profile.apiKey}`,
      }),
      taskId,
    };
  }
  if (!fileId) throw new Error('Hailuo completed without file_id or video url.');
  const fileMeta = await requestJson(
    `${base}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    undefined,
    { Authorization: `Bearer ${profile.apiKey}` },
    { ...options, method: 'GET' },
  );
  const downloadUrl = stringValue(asRecord(fileMeta.file).download_url)
    || stringValue(fileMeta.download_url);
  if (!downloadUrl) throw new Error('Hailuo file retrieve did not include download_url.');
  return {
    bytes: await downloadBinary(downloadUrl, options.fetch, options.signal, {
      Authorization: `Bearer ${profile.apiKey}`,
    }),
    taskId,
  };
}

async function runHappyHorse(
  input: VideoGenInput,
  negativePrompt: string,
  profile: MediaGenProfile,
  options: {
    cwd: string;
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<{ bytes: Buffer; taskId?: string }> {
  const base = resolveProfileBaseUrl(profile);
  const body: Record<string, unknown> = {
    model: profile.model,
    input: {
      prompt: input.prompt,
      negative_prompt: negativePrompt,
    },
    parameters: {
      resolution: input.resolution || '720P',
      duration: input.duration ?? 5,
      prompt_extend: input.promptExtend ?? input.prompt.split(/\s+/u).length < 30,
    },
  };
  if (input.imagePath?.trim()) {
    const absolute = path.resolve(options.cwd, input.imagePath.trim());
    const data = await readFile(absolute);
    const b64 = data.toString('base64');
    const ext = path.extname(absolute).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : 'image/png';
    (body.input as Record<string, unknown>).media = [{
      type: 'first_frame',
      url: `data:${mime};base64,${b64}`,
    }];
    if (!profile.model.includes('i2v')) {
      body.model = profile.model.replace(/-t2v$/u, '-i2v');
    }
  }
  const created = await requestJson(
    `${base}/services/aigc/video-generation/video-synthesis`,
    body,
    {
      Authorization: `Bearer ${profile.apiKey}`,
      'X-DashScope-Async': 'enable',
    },
    options,
  );
  const taskId = stringValue(asRecord(created.output).task_id)
    || stringValue(created.task_id);
  if (!taskId) throw new Error('HappyHorse did not return a task_id.');
  const final = await pollUntil<Record<string, unknown>>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/tasks/${encodeURIComponent(taskId)}`,
        undefined,
        { Authorization: `Bearer ${profile.apiKey}` },
        { ...options, method: 'GET' },
      );
      const output = asRecord(status.output);
      const state = stringValue(output.task_status || status.task_status).toUpperCase();
      if (state === 'SUCCEEDED') return { done: true, value: status };
      if (state === 'FAILED' || state === 'CANCELED' || state === 'CANCELLED') {
        return {
          done: false,
          failed: stringValue(output.message) || `HappyHorse task ${state}`,
        };
      }
      return { done: false };
    },
  });
  const output = asRecord(final.output);
  const results = Array.isArray(output.results) ? output.results : [];
  const videoUrl = stringValue(output.video_url)
    || stringValue(asRecord(results[0]).url);
  if (!videoUrl) throw new Error('HappyHorse completed without video_url.');
  return {
    bytes: await downloadBinary(videoUrl, options.fetch, options.signal),
    taskId,
  };
}

async function requestJson(
  url: string,
  body: unknown | undefined,
  headers: Record<string, string>,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    method?: 'GET' | 'POST';
  },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const response = await options.fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw new Error(
        `Video API ${response.status}: ${text.slice(0, 500) || response.statusText}`,
      );
    }
    return asRecord(parsed);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function buildVideoGenConfigFromStored(
  stored: Record<string, unknown>,
): MediaGenPluginConfig {
  return {
    enabled: stored.enabled === true,
    defaultProfileId: stringValue(stored.defaultProfileId) || undefined,
    profiles: availableMediaProfiles(stored, 'video'),
    timeoutMs: numberValue(stored.timeoutMs),
    pollIntervalMs: numberValue(stored.pollIntervalMs),
    maxWaitMs: numberValue(stored.maxWaitMs),
  };
}
