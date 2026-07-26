import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import { redactSurfaceText } from '../surfaces/redaction.js';
import type { AgentToolDefinition } from '../types.js';

export const MANAGED_OCR_MAX_INPUT_BYTES = 20 * 1024 * 1024;

export type ManagedOcrProvider = 'qwen' | 'openai-compatible' | 'mistral';
export type ManagedOcrApi = 'chat-completions' | 'responses';

export interface ManagedOcrConfig {
  provider: ManagedOcrProvider;
  api?: ManagedOcrApi;
  /** Server-side only. Never include this configuration object in a renderer DTO. */
  apiKey: string;
  baseUrl?: string;
  /** Compatibility alias for settings stores that use the SDK's `baseURL` spelling. */
  baseURL?: string;
  model?: string;
  prompt?: string;
  timeoutMs?: number;
}

export interface ManagedOcrInput {
  /** An HTTP(S) URL or a local file path, resolved relative to `cwd`. */
  source: string;
  /** Required for URLs whose path does not identify an image or PDF. */
  mediaType?: string;
  prompt?: string;
}

export interface ManagedOcrPage {
  index: number;
  text: string;
}

export interface ManagedOcrResult {
  provider: ManagedOcrProvider;
  model: string;
  pages: ManagedOcrPage[];
}

export type ManagedOcrFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ManagedOcrRuntimeOptions {
  cwd?: string;
  fetch?: ManagedOcrFetch;
  signal?: AbortSignal;
}

export interface ManagedOcrToolOptions {
  name?: string;
  cwd?: string;
  fetch?: ManagedOcrFetch;
}

interface ResolvedOcrConfig {
  provider: ManagedOcrProvider;
  api: ManagedOcrApi;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface ResolvedOcrSource {
  value: string;
  mediaType?: string;
  fileName?: string;
  document: boolean;
}

const DEFAULT_PROMPT =
  'Extract all readable text. Preserve headings, tables, and reading order where possible.';

const MEDIA_TYPES = new Map<string, string>([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webp', 'image/webp'],
]);

const DEFAULTS: Record<
  ManagedOcrProvider,
  { baseUrl: string; model: string; api: ManagedOcrApi }
> = {
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-ocr-latest',
    api: 'chat-completions',
  },
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    api: 'chat-completions',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-ocr-latest',
    api: 'chat-completions',
  },
};

const managedOcrInputSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .describe('HTTP(S) URL or local image/PDF path. Relative paths use the workspace cwd.'),
  mediaType: z
    .string()
    .min(1)
    .optional()
    .describe('Optional MIME type, useful for extensionless URLs.'),
  prompt: z.string().min(1).max(20_000).optional(),
});

const managedOcrResultSchema = z.object({
  provider: z.enum(['qwen', 'openai-compatible', 'mistral']),
  model: z.string(),
  pages: z.array(z.object({
    index: z.number().int().nonnegative(),
    text: z.string(),
  })),
});

export async function runManagedOcr(
  input: ManagedOcrInput,
  config: ManagedOcrConfig,
  options: ManagedOcrRuntimeOptions = {},
): Promise<ManagedOcrResult> {
  const resolvedConfig = resolveConfig(config);
  const source = await resolveSource(input, options.cwd ?? process.cwd());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('OCR requires a Fetch-compatible runtime or an injected fetch implementation.');
  }

  if (resolvedConfig.provider === 'mistral') {
    return runMistralOcr(source, resolvedConfig, fetchImpl, options.signal);
  }
  if (resolvedConfig.api === 'responses') {
    return runResponsesOcr(
      source,
      input.prompt ?? config.prompt ?? DEFAULT_PROMPT,
      resolvedConfig,
      fetchImpl,
      options.signal,
    );
  }
  return runChatCompletionsOcr(
    source,
    input.prompt ?? config.prompt ?? DEFAULT_PROMPT,
    resolvedConfig,
    fetchImpl,
    options.signal,
  );
}

export function createManagedOcrTool(
  config: ManagedOcrConfig,
  options: ManagedOcrToolOptions = {},
): AgentToolDefinition<ManagedOcrInput, ManagedOcrResult> {
  return tool(
    {
      name: options.name?.trim() || 'OCR',
      description:
        'Extract text from a local image/PDF or an HTTP(S) media URL using the configured OCR provider.',
      inputSchema: managedOcrInputSchema,
      outputSchema: managedOcrResultSchema,
      isReadOnly: () => true,
      isDestructive: () => false,
      requiresUserInteraction: () => true,
      isConcurrencySafe: () => true,
      interruptBehavior: 'cancel',
      getToolUseSummary: input => `OCR ${input.source}`,
      serialize: output => output.pages.map(page => page.text).join('\n\n'),
    },
    (input, context) =>
      runManagedOcr(input, config, {
        cwd: options.cwd ?? context.cwd,
        fetch: options.fetch,
        signal: context.signal,
      }),
  );
}

async function runChatCompletionsOcr(
  source: ResolvedOcrSource,
  prompt: string,
  config: ResolvedOcrConfig,
  fetchImpl: ManagedOcrFetch,
  signal?: AbortSignal,
): Promise<ManagedOcrResult> {
  if (source.document) {
    throw new Error(
      `OCR ${config.provider} chat-completions accepts image input only; use the responses API or Mistral for PDFs.`,
    );
  }
  const response = await requestJson(
    `${config.baseUrl}/chat/completions`,
    {
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: source.value } },
        ],
      }],
      stream: false,
    },
    config,
    fetchImpl,
    signal,
  );
  const record = asRecord(response);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice.message);
  const text = textFromChatContent(message.content);
  if (!text) {
    throw new Error(`OCR ${config.provider} returned no text in its chat-completions response.`);
  }
  return onePageResult(config, record, text);
}

async function runResponsesOcr(
  source: ResolvedOcrSource,
  prompt: string,
  config: ResolvedOcrConfig,
  fetchImpl: ManagedOcrFetch,
  signal?: AbortSignal,
): Promise<ManagedOcrResult> {
  const mediaItem = source.document
    ? {
        type: 'input_file',
        ...(isDataUrl(source.value)
          ? { file_data: source.value }
          : { file_url: source.value }),
        ...(source.fileName ? { filename: source.fileName } : {}),
      }
    : {
        type: 'input_image',
        image_url: source.value,
      };
  const response = await requestJson(
    `${config.baseUrl}/responses`,
    {
      model: config.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          mediaItem,
        ],
      }],
    },
    config,
    fetchImpl,
    signal,
  );
  const record = asRecord(response);
  const text = textFromResponses(record);
  if (!text) {
    throw new Error(`OCR ${config.provider} returned no text in its Responses API result.`);
  }
  return onePageResult(config, record, text);
}

async function runMistralOcr(
  source: ResolvedOcrSource,
  config: ResolvedOcrConfig,
  fetchImpl: ManagedOcrFetch,
  signal?: AbortSignal,
): Promise<ManagedOcrResult> {
  const document = source.document
    ? { type: 'document_url', document_url: source.value }
    : { type: 'image_url', image_url: source.value };
  const response = await requestJson(
    `${config.baseUrl}/ocr`,
    {
      model: config.model,
      document,
      include_image_base64: false,
    },
    config,
    fetchImpl,
    signal,
  );
  const record = asRecord(response);
  const rawPages = Array.isArray(record.pages) ? record.pages : [];
  const pages = rawPages
    .map((page, position): ManagedOcrPage | undefined => {
      const item = asRecord(page);
      const text = firstString(item.markdown, item.text, item.content);
      if (text === undefined) return undefined;
      return {
        index: finiteInteger(item.index) ?? position,
        text,
      };
    })
    .filter((page): page is ManagedOcrPage => Boolean(page));
  if (pages.length === 0) {
    throw new Error('OCR mistral returned no readable pages.');
  }
  return {
    provider: config.provider,
    model: firstString(record.model) ?? config.model,
    pages,
  };
}

async function resolveSource(
  input: ManagedOcrInput,
  cwd: string,
): Promise<ResolvedOcrSource> {
  const rawSource = input.source.trim();
  const configuredMediaType = normalizeMediaType(input.mediaType);
  if (/^https?:\/\//iu.test(rawSource)) {
    let parsed: URL;
    try {
      parsed = new URL(rawSource);
    } catch {
      throw new Error(`Invalid OCR media URL: ${rawSource}`);
    }
    const mediaType = configuredMediaType ?? mediaTypeFromPath(parsed.pathname);
    return {
      value: parsed.toString(),
      mediaType,
      fileName: fileNameFromPath(parsed.pathname),
      document: mediaType === 'application/pdf',
    };
  }
  if (
    path.isAbsolute(rawSource)
    || path.posix.isAbsolute(rawSource)
    || path.win32.isAbsolute(rawSource)
    || /^[a-z]:/iu.test(rawSource)
  ) {
    throw new Error('OCR local source must be a workspace-relative path.');
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(rawSource)) {
    throw new Error('OCR source URLs must use HTTP or HTTPS.');
  }
  if (rawSource.split(/[\\/]+/u).includes('..')) {
    throw new Error("OCR local source must not contain '..' path segments.");
  }

  let workspacePath: string;
  try {
    workspacePath = await realpath(cwd);
  } catch (error) {
    throw new Error('OCR workspace could not be resolved.', { cause: error });
  }
  const candidatePath = path.resolve(workspacePath, rawSource);
  let filePath: string;
  try {
    filePath = await realpath(candidatePath);
  } catch (error) {
    throw new Error(`OCR input file was not found or could not be read: ${candidatePath}`, {
      cause: error,
    });
  }
  if (!isPathInside(workspacePath, filePath)) {
    throw new Error('OCR input resolves outside the configured workspace.');
  }
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    throw new Error(`OCR input file was not found or could not be read: ${filePath}`, {
      cause: error,
    });
  }
  if (!fileStats.isFile()) {
    throw new Error(`OCR input must be a file: ${filePath}`);
  }
  assertWithinInputLimit(fileStats.size, filePath);
  const bytes = await readFile(filePath);
  assertWithinInputLimit(bytes.byteLength, filePath);
  const mediaType = configuredMediaType ?? mediaTypeFromPath(filePath);
  if (!mediaType) {
    throw new Error(
      `Could not infer the OCR media type for ${filePath}; provide mediaType explicitly.`,
    );
  }
  if (mediaType !== 'application/pdf' && !mediaType.startsWith('image/')) {
    throw new Error(`Unsupported OCR media type: ${mediaType}. Use an image or PDF.`);
  }
  return {
    value: `data:${mediaType};base64,${bytes.toString('base64')}`,
    mediaType,
    fileName: path.basename(rawSource),
    document: mediaType === 'application/pdf',
  };
}

async function requestJson(
  url: string,
  body: Record<string, unknown>,
  config: ResolvedOcrConfig,
  fetchImpl: ManagedOcrFetch,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const request = requestAbortSignal(externalSignal, config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    request.cleanup();
    if (externalSignal?.aborted) {
      throw new Error(`OCR ${config.provider} request was cancelled.`, { cause: error });
    }
    if (request.signal.aborted) {
      throw new Error(
        `OCR ${config.provider} request timed out after ${config.timeoutMs} ms.`,
        { cause: error },
      );
    }
    throw new Error(`OCR ${config.provider} request failed: ${safeErrorMessage(error, config.apiKey)}`, {
      cause: error,
    });
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new Error(`OCR ${config.provider} response was cancelled.`, { cause: error });
    }
    if (request.signal.aborted) {
      throw new Error(
        `OCR ${config.provider} response timed out after ${config.timeoutMs} ms.`,
        { cause: error },
      );
    }
    throw new Error(
      `OCR ${config.provider} response could not be read: ${safeErrorMessage(error, config.apiKey)}`,
      { cause: error },
    );
  } finally {
    request.cleanup();
  }
  if (!response.ok) {
    const detail = providerErrorDetail(responseText, config.apiKey);
    throw new Error(
      `OCR ${config.provider} request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
    );
  }
  if (!responseText.trim()) {
    throw new Error(`OCR ${config.provider} returned an empty response.`);
  }
  try {
    return JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new Error(`OCR ${config.provider} returned invalid JSON.`, { cause: error });
  }
}

function resolveConfig(config: ManagedOcrConfig): ResolvedOcrConfig {
  if (config.provider !== 'qwen' && config.provider !== 'openai-compatible' && config.provider !== 'mistral') {
    throw new Error(`Unsupported OCR provider: ${String(config.provider)}`);
  }
  const defaults = DEFAULTS[config.provider];
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(`OCR ${config.provider} requires an API key.`);
  }
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.max(1_000, Math.min(180_000, Math.trunc(config.timeoutMs!)))
    : 60_000;
  return {
    provider: config.provider,
    api: config.provider === 'mistral' ? defaults.api : config.api ?? defaults.api,
    apiKey,
    baseUrl: (
      config.baseUrl?.trim()
      || config.baseURL?.trim()
      || defaults.baseUrl
    ).replace(/\/+$/u, ''),
    model: config.model?.trim() || defaults.model,
    timeoutMs,
  };
}

function onePageResult(
  config: ResolvedOcrConfig,
  response: Record<string, unknown>,
  text: string,
): ManagedOcrResult {
  return {
    provider: config.provider,
    model: firstString(response.model) ?? config.model,
    pages: [{ index: 0, text }],
  };
}

function textFromChatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (typeof item === 'string') return item;
      const record = asRecord(item);
      return firstString(record.text, record.output_text) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function textFromResponses(response: Record<string, unknown>): string {
  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const output of Array.isArray(response.output) ? response.output : []) {
    const item = asRecord(output);
    if (typeof item.text === 'string') parts.push(item.text);
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content === 'string') {
        parts.push(content);
        continue;
      }
      const part = asRecord(content);
      const text = firstString(part.text, part.output_text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function requestAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`OCR request timed out after ${timeoutMs} ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function providerErrorDetail(responseText: string, apiKey: string): string {
  let candidate = responseText;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    const record = asRecord(parsed);
    const error = asRecord(record.error);
    candidate = firstString(error.message, record.message, error.code) ?? responseText;
  } catch {
    // A provider may return plain text for proxy and authentication failures.
  }
  return redactSecret(redactSurfaceText(candidate), apiKey)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function safeErrorMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecret(redactSurfaceText(message), apiKey);
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

function assertWithinInputLimit(size: number, source: string): void {
  if (size <= MANAGED_OCR_MAX_INPUT_BYTES) return;
  throw new Error(
    `OCR input exceeds the 20 MB limit (${size} bytes): ${source}`,
  );
}

function normalizeMediaType(value: string | undefined): string | undefined {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized !== 'application/pdf' && !normalized.startsWith('image/')) {
    throw new Error(`Unsupported OCR media type: ${normalized}. Use an image or PDF.`);
  }
  return normalized;
}

function mediaTypeFromPath(filePath: string): string | undefined {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
}

function fileNameFromPath(filePath: string): string | undefined {
  const name = path.posix.basename(filePath);
  return name && name !== '/' && name !== '.' ? name : undefined;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function isDataUrl(value: string): boolean {
  return value.startsWith('data:');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string') as string | undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
