import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import {
  MESH_GEN_PROMPT_GUIDANCE,
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

export interface MeshGenToolOptions {
  name?: string;
  cwd?: string;
  fetch?: MediaGenFetch;
  config: MediaGenPluginConfig;
}

export interface MeshGenInput {
  prompt: string;
  userIntent?: string;
  profile?: string;
  outputPath?: string;
  refine?: boolean;
}

export interface MeshGenResult {
  profile: string;
  provider: string;
  model: string;
  path: string;
  prompt: string;
  userIntent?: string;
  bytes: number;
  taskId?: string;
}

const inputSchema = z.strictObject({
  prompt: z
    .string()
    .min(1)
    .max(4_000)
    .describe('Professional text-to-3D prompt (rewritten by the agent).'),
  userIntent: z.string().max(4_000).optional(),
  profile: z.string().min(1).optional(),
  outputPath: z.string().min(1).optional(),
  refine: z
    .boolean()
    .optional()
    .describe('Meshy only: run preview then refine for textured mesh (default true).'),
});

export function createMeshGenTool(
  options: MeshGenToolOptions,
): AgentToolDefinition<MeshGenInput, MeshGenResult> {
  const profiles = availableMediaProfiles(
    { profiles: options.config.profiles },
    'mesh',
  );
  const profilePrompt = formatAvailableProfilesPrompt(
    profiles,
    options.config.defaultProfileId,
  );

  return tool(
    {
      name: options.name?.trim() || 'generate_mesh',
      description:
        'Generate a 3D mesh (GLB) with a configured 3D Generation profile (Meshy, Tripo, or Rodin). Rewrite casual user requests into a professional modeling prompt before calling.',
      inputSchema,
      isReadOnly: () => false,
      isDestructive: () => false,
      requiresUserInteraction: () => false,
      interruptBehavior: 'cancel',
      getToolUseSummary: input => `Generate mesh (${input.profile || 'default'})`,
      prompt: () => `${MESH_GEN_PROMPT_GUIDANCE}\n\n${profilePrompt}`,
    },
    async (input, context) => {
      const selected = selectMediaProfile(
        profiles,
        input.profile,
        options.config.defaultProfileId,
      );
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('3D generation requires fetch.');
      }
      const cwd = options.cwd ?? context.cwd ?? process.cwd();
      const generated = await generateMeshFile(input, selected, {
        fetch: fetchImpl,
        signal: context.signal,
        timeoutMs: options.config.timeoutMs ?? 120_000,
        pollIntervalMs: options.config.pollIntervalMs ?? 3_000,
        maxWaitMs: options.config.maxWaitMs ?? 900_000,
      });
      const filename = `${timestampSlug()}-${selected.id}.glb`;
      const written = await writeGeneratedArtifact(
        cwd,
        'mesh',
        filename,
        generated.bytes,
        input.outputPath,
      );
      const result: MeshGenResult = {
        profile: selected.id,
        provider: selected.provider,
        model: selected.model,
        path: written.relativePath,
        prompt: input.prompt,
        bytes: generated.bytes.byteLength,
      };
      if (input.userIntent?.trim()) result.userIntent = input.userIntent.trim();
      if (generated.taskId) result.taskId = generated.taskId;
      return result;
    },
  );
}

async function generateMeshFile(
  input: MeshGenInput,
  profile: MediaGenProfile,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<{ bytes: Buffer; taskId?: string }> {
  if (profile.provider === 'meshy') return runMeshy(input, profile, options);
  if (profile.provider === 'tripo') return runTripo(input, profile, options);
  if (profile.provider === 'rodin') return runRodin(input, profile, options);
  throw new Error(`Unsupported mesh provider: ${profile.provider}`);
}

async function runMeshy(
  input: MeshGenInput,
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
  const headers = { Authorization: `Bearer ${profile.apiKey}` };
  const preview = await requestJson(
    `${base}/openapi/v2/text-to-3d`,
    {
      mode: 'preview',
      prompt: input.prompt,
      ai_model: profile.model === 'latest' ? 'latest' : profile.model,
      should_remesh: true,
    },
    headers,
    options,
  );
  const previewId = stringValue(preview.result) || stringValue(preview.id);
  if (!previewId) throw new Error('Meshy preview did not return a task id.');
  await waitMeshyTask(base, previewId, headers, options);
  let taskId = previewId;
  if (input.refine !== false) {
    const refine = await requestJson(
      `${base}/openapi/v2/text-to-3d`,
      {
        mode: 'refine',
        preview_task_id: previewId,
        enable_pbr: true,
      },
      headers,
      options,
    );
    taskId = stringValue(refine.result) || stringValue(refine.id) || previewId;
    await waitMeshyTask(base, taskId, headers, options);
  }
  const detail = await requestJson(
    `${base}/openapi/v2/text-to-3d/${encodeURIComponent(taskId)}`,
    undefined,
    headers,
    { ...options, method: 'GET' },
  );
  const modelUrls = asRecord(detail.model_urls);
  const glbUrl = stringValue(modelUrls.glb)
    || stringValue(asRecord(detail.model_url).glb)
    || stringValue(detail.model_url);
  if (!glbUrl) throw new Error('Meshy completed without a GLB url.');
  return {
    bytes: await downloadBinary(glbUrl, options.fetch, options.signal),
    taskId,
  };
}

async function waitMeshyTask(
  base: string,
  taskId: string,
  headers: Record<string, string>,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
): Promise<void> {
  await pollUntil<true>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/openapi/v2/text-to-3d/${encodeURIComponent(taskId)}`,
        undefined,
        headers,
        { ...options, method: 'GET' },
      );
      const state = stringValue(status.status).toUpperCase();
      if (state === 'SUCCEEDED') return { done: true, value: true as const };
      if (state === 'FAILED' || state === 'CANCELED') {
        return {
          done: false,
          failed: stringValue(asRecord(status.task_error).message)
            || `Meshy task ${state}`,
        };
      }
      return { done: false };
    },
  });
}

async function runTripo(
  input: MeshGenInput,
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
  const headers = { Authorization: `Bearer ${profile.apiKey}` };
  const created = await requestJson(
    `${base}/v2/openapi/task`,
    {
      type: 'text_to_model',
      model_version: profile.model,
      prompt: input.prompt,
    },
    headers,
    options,
  );
  const taskId = stringValue(asRecord(created.data).task_id)
    || stringValue(created.task_id);
  if (!taskId) throw new Error('Tripo did not return a task_id.');
  const final = await pollUntil<Record<string, unknown>>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/v2/openapi/task/${encodeURIComponent(taskId)}`,
        undefined,
        headers,
        { ...options, method: 'GET' },
      );
      const data = asRecord(status.data);
      const state = stringValue(data.status || status.status).toLowerCase();
      if (state === 'success' || state === 'succeeded') {
        return { done: true, value: data };
      }
      if (state === 'failed' || state === 'cancelled' || state === 'canceled') {
        return {
          done: false,
          failed: stringValue(data.error_msg) || `Tripo task ${state}`,
        };
      }
      return { done: false };
    },
  });
  const output = asRecord(final.output);
  const glbUrl = stringValue(output.model)
    || stringValue(output.pbr_model)
    || stringValue(asRecord(final.result).model);
  if (!glbUrl) throw new Error('Tripo completed without a model url.');
  return {
    bytes: await downloadBinary(glbUrl, options.fetch, options.signal),
    taskId,
  };
}

async function runRodin(
  input: MeshGenInput,
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
  const headers = { Authorization: `Bearer ${profile.apiKey}` };
  const created = await requestJson(
    `${base}/api/v2/rodin`,
    {
      prompt: input.prompt,
      tier: profile.model || 'Regular',
    },
    headers,
    options,
  );
  const taskId = stringValue(asRecord(created).uuid)
    || stringValue(created.task_uuid)
    || stringValue(asRecord(created.data).uuid);
  if (!taskId) throw new Error('Rodin did not return a task uuid.');
  const final = await pollUntil<Record<string, unknown>>({
    intervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    signal: options.signal,
    tick: async () => {
      const status = await requestJson(
        `${base}/api/v2/status`,
        { subscription_key: taskId },
        headers,
        options,
      );
      const jobs = Array.isArray(status.jobs) ? status.jobs : [];
      const states = jobs.map(job => stringValue(asRecord(job).status).toLowerCase());
      if (states.length > 0 && states.every(s => s === 'done' || s === 'completed')) {
        return { done: true, value: status };
      }
      if (states.some(s => s === 'failed' || s === 'error')) {
        return { done: false, failed: 'Rodin task failed.' };
      }
      const single = stringValue(status.status).toLowerCase();
      if (single === 'done' || single === 'completed') {
        return { done: true, value: status };
      }
      if (single === 'failed' || single === 'error') {
        return { done: false, failed: 'Rodin task failed.' };
      }
      return { done: false };
    },
  });
  const download = await requestJson(
    `${base}/api/v2/download`,
    { task_uuid: taskId },
    headers,
    options,
  );
  const list = Array.isArray(download.list) ? download.list : [];
  const glb = list.find(item => {
    const url = stringValue(asRecord(item).url) || stringValue(item);
    return url.toLowerCase().includes('.glb');
  });
  const glbUrl = stringValue(asRecord(glb).url)
    || stringValue(download.glb_url)
    || stringValue(asRecord(final).glb_url);
  if (!glbUrl) throw new Error('Rodin completed without a GLB download url.');
  return {
    bytes: await downloadBinary(glbUrl, options.fetch, options.signal),
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
        `Mesh API ${response.status}: ${text.slice(0, 500) || response.statusText}`,
      );
    }
    return asRecord(parsed);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function buildMeshGenConfigFromStored(
  stored: Record<string, unknown>,
): MediaGenPluginConfig {
  return {
    enabled: stored.enabled === true,
    defaultProfileId: stringValue(stored.defaultProfileId) || undefined,
    profiles: availableMediaProfiles(stored, 'mesh'),
    timeoutMs: numberValue(stored.timeoutMs),
    pollIntervalMs: numberValue(stored.pollIntervalMs),
    maxWaitMs: numberValue(stored.maxWaitMs),
  };
}
