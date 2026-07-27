import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import {
  DEFAULT_IMAGE_NEGATIVE_PROMPT,
  IMAGE_GEN_PROMPT_GUIDANCE,
  formatAvailableProfilesPrompt,
} from './mediaGenPromptGuidance.js';
import {
  asRecord,
  availableMediaProfiles,
  downloadBinary,
  numberValue,
  resolveProfileBaseUrl,
  selectMediaProfile,
  stringValue,
  timestampSlug,
  writeGeneratedArtifact,
  type MediaGenFetch,
  type MediaGenProfile,
  type MediaGenPluginConfig,
} from './mediaGenProfiles.js';

export interface ImageGenToolOptions {
  name?: string;
  cwd?: string;
  fetch?: MediaGenFetch;
  config: MediaGenPluginConfig;
}

export interface ImageGenInput {
  prompt: string;
  userIntent?: string;
  negativePrompt?: string;
  profile?: string;
  outputPath?: string;
  size?: string;
  promptExtend?: boolean;
}

export interface ImageGenResult {
  profile: string;
  provider: string;
  model: string;
  path: string;
  prompt: string;
  userIntent?: string;
  negativePrompt?: string;
  bytes: number;
}

const inputSchema = z.strictObject({
  prompt: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'Professional image-generation prompt (rewritten by the agent from the user intent).',
    ),
  userIntent: z
    .string()
    .max(4_000)
    .optional()
    .describe('Original user wording for audit only; never sent to the provider.'),
  negativePrompt: z.string().max(2_000).optional(),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('Profile id, label, model, or provider to use.'),
  outputPath: z.string().min(1).optional(),
  size: z.string().min(1).optional().describe('Optional size such as 1024x1024 or 1328*1328.'),
  promptExtend: z
    .boolean()
    .optional()
    .describe('DashScope only: vendor-side prompt rewrite (true for short prompts).'),
});

export function createImageGenTool(
  options: ImageGenToolOptions,
): AgentToolDefinition<ImageGenInput, ImageGenResult> {
  const profiles = availableMediaProfiles(
    { profiles: options.config.profiles },
    'image',
  );
  const profilePrompt = formatAvailableProfilesPrompt(
    profiles,
    options.config.defaultProfileId,
  );

  return tool(
    {
      name: options.name?.trim() || 'generate_image',
      description:
        'Generate an image with a configured Image Generation profile (Gemini Nano Banana, GPT Image 2, or Qwen-Image). Rewrite casual user requests into a professional prompt before calling.',
      inputSchema,
      isReadOnly: () => false,
      isDestructive: () => false,
      requiresUserInteraction: () => false,
      interruptBehavior: 'cancel',
      getToolUseSummary: input => `Generate image (${input.profile || 'default'})`,
      prompt: () => `${IMAGE_GEN_PROMPT_GUIDANCE}\n\n${profilePrompt}`,
    },
    async (input, context) => {
      const selected = selectMediaProfile(
        profiles,
        input.profile,
        options.config.defaultProfileId,
      );
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('Image generation requires fetch.');
      }
      const negative = input.negativePrompt?.trim() || DEFAULT_IMAGE_NEGATIVE_PROMPT;
      const buffer = await generateImageBytes(input.prompt, negative, selected, {
        size: input.size,
        promptExtend: input.promptExtend,
        fetch: fetchImpl,
        signal: context.signal,
        timeoutMs: options.config.timeoutMs ?? 180_000,
      });
      const filename = `${timestampSlug()}-${selected.id}.png`;
      const written = await writeGeneratedArtifact(
        options.cwd ?? context.cwd ?? process.cwd(),
        'image',
        filename,
        buffer,
        input.outputPath,
      );
      const result: ImageGenResult = {
        profile: selected.id,
        provider: selected.provider,
        model: selected.model,
        path: written.relativePath,
        prompt: input.prompt,
        bytes: buffer.byteLength,
        negativePrompt: negative,
      };
      if (input.userIntent?.trim()) result.userIntent = input.userIntent.trim();
      return result;
    },
  );
}

async function generateImageBytes(
  prompt: string,
  negativePrompt: string,
  profile: MediaGenProfile,
  options: {
    size?: string;
    promptExtend?: boolean;
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Buffer> {
  if (profile.provider === 'gemini') {
    return generateGeminiImage(prompt, profile, options);
  }
  if (profile.provider === 'openai') {
    return generateOpenaiImage(prompt, profile, options);
  }
  if (profile.provider === 'dashscope') {
    return generateDashscopeImage(prompt, negativePrompt, profile, options);
  }
  throw new Error(`Unsupported image provider: ${profile.provider}`);
}

async function generateGeminiImage(
  prompt: string,
  profile: MediaGenProfile,
  options: {
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Buffer> {
  const base = resolveProfileBaseUrl(profile);
  const url = `${base}/models/${encodeURIComponent(profile.model)}:generateContent`;
  const response = await requestJson(
    url,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    {
      Authorization: `Bearer ${profile.apiKey}`,
      'x-goog-api-key': profile.apiKey,
    },
    options,
  );
  const choices = Array.isArray(response.candidates) ? response.candidates : [];
  const content = asRecord(asRecord(choices[0]).content);
  const partList = Array.isArray(content.parts) ? content.parts : [];
  for (const part of partList) {
    const record = asRecord(part);
    const inline = asRecord(record.inlineData ?? record.inline_data);
    const data = stringValue(inline.data);
    if (data) return Buffer.from(data, 'base64');
  }
  throw new Error('Gemini image response did not include inline image data.');
}

async function generateOpenaiImage(
  prompt: string,
  profile: MediaGenProfile,
  options: {
    size?: string;
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Buffer> {
  const base = resolveProfileBaseUrl(profile);
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt,
    n: 1,
  };
  if (options.size?.trim()) body.size = options.size.trim();
  const response = await requestJson(
    `${base}/images/generations`,
    body,
    { Authorization: `Bearer ${profile.apiKey}` },
    options,
  );
  const data = Array.isArray(response.data) ? response.data : [];
  const first = asRecord(data[0]);
  const b64 = stringValue(first.b64_json ?? first.b64Json);
  if (b64) return Buffer.from(b64, 'base64');
  const url = stringValue(first.url);
  if (url) {
    return downloadBinary(url, options.fetch, options.signal, {
      Authorization: `Bearer ${profile.apiKey}`,
    });
  }
  throw new Error('OpenAI image response did not include b64_json or url.');
}

async function generateDashscopeImage(
  prompt: string,
  negativePrompt: string,
  profile: MediaGenProfile,
  options: {
    size?: string;
    promptExtend?: boolean;
    fetch: MediaGenFetch;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Buffer> {
  const base = resolveProfileBaseUrl(profile);
  const size = options.size?.includes('*')
    ? options.size
    : options.size?.includes('x')
      ? options.size.replace(/x/giu, '*')
      : '1328*1328';
  const body = {
    model: profile.model,
    input: {
      messages: [{
        role: 'user',
        content: [{ text: prompt }],
      }],
    },
    parameters: {
      negative_prompt: negativePrompt,
      prompt_extend: options.promptExtend ?? prompt.split(/\s+/u).length < 30,
      watermark: false,
      size,
      n: 1,
    },
  };
  const response = await requestJson(
    `${base}/services/aigc/multimodal-generation/generation`,
    body,
    { Authorization: `Bearer ${profile.apiKey}` },
    options,
  );
  const output = asRecord(response.output);
  const choices = Array.isArray(output.choices) ? output.choices : [];
  for (const choice of choices) {
    const message = asRecord(asRecord(choice).message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      const record = asRecord(item);
      const image = stringValue(record.image) || stringValue(asRecord(record.image).url);
      if (image.startsWith('data:')) {
        const b64 = image.split(',')[1];
        if (b64) return Buffer.from(b64, 'base64');
      }
      if (image.startsWith('http')) {
        return downloadBinary(image, options.fetch, options.signal);
      }
      const b64 = stringValue(record.b64_json ?? record.b64Json);
      if (b64) return Buffer.from(b64, 'base64');
    }
  }
  const results = Array.isArray(output.results) ? output.results : [];
  for (const item of results) {
    const url = stringValue(asRecord(item).url);
    if (url) return downloadBinary(url, options.fetch, options.signal);
  }
  throw new Error('DashScope image response did not include image data.');
}

async function requestJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: { fetch: MediaGenFetch; signal?: AbortSignal; timeoutMs: number },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await options.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
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
        `Image API ${response.status}: ${text.slice(0, 500) || response.statusText}`,
      );
    }
    return asRecord(parsed);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function buildImageGenConfigFromStored(
  stored: Record<string, unknown>,
): MediaGenPluginConfig {
  return {
    enabled: stored.enabled === true,
    defaultProfileId: stringValue(stored.defaultProfileId) || undefined,
    profiles: availableMediaProfiles(stored, 'image'),
    timeoutMs: numberValue(stored.timeoutMs),
    pollIntervalMs: numberValue(stored.pollIntervalMs),
    maxWaitMs: numberValue(stored.maxWaitMs),
  };
}
