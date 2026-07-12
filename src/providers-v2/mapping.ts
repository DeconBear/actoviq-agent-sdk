import type {
  InputItem,
  JsonObject,
  JsonValue,
  OutputItem,
  Usage,
} from '../core/index.js';

import { isRecord } from './adapter-base.js';
import type { ModelFinishReason, ModelRequest } from './types.js';

export interface ImageSourceParts {
  readonly kind: 'url' | 'base64' | 'file';
  readonly url?: string;
  readonly data?: string;
  readonly mediaType?: string;
  readonly fileId?: string;
  readonly detail?: 'auto' | 'low' | 'high';
  readonly role: 'user' | 'assistant';
}

export function itemRecord(item: InputItem | OutputItem): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}

export function imageSourceParts(item: InputItem): ImageSourceParts {
  const record = itemRecord(item);
  const source = isRecord(record.source) ? record.source : record;
  const kind = source.kind === 'file' || source.type === 'file'
    ? 'file'
    : source.kind === 'base64' || source.type === 'base64'
      ? 'base64'
      : 'url';
  const role = record.role === 'assistant' ? 'assistant' : 'user';
  const detail = record.detail === 'low' || record.detail === 'high' || record.detail === 'auto'
    ? record.detail
    : undefined;
  return {
    kind,
    url: stringOrUndefined(source.url),
    data: stringOrUndefined(source.data),
    mediaType: stringOrUndefined(source.mediaType) ?? stringOrUndefined(source.media_type),
    fileId: stringOrUndefined(source.fileId) ?? stringOrUndefined(source.file_id),
    detail,
    role,
  };
}

export function textOutput(text: string): OutputItem {
  return { type: 'text', role: 'assistant', text } as OutputItem;
}

export function toolCallOutput(
  id: string,
  name: string,
  input: unknown,
): OutputItem {
  return {
    type: 'tool_call',
    id,
    name,
    input: jsonObject(input),
  } as OutputItem;
}

export function reasoningOutput(
  provider: string,
  opaque: unknown,
  summary?: string,
): OutputItem {
  return {
    type: 'reasoning',
    provider,
    ...(summary ? { summary } : {}),
    opaque: jsonValue(opaque),
  } as OutputItem;
}

export function rawOutput(provider: string, value: unknown): OutputItem {
  return {
    type: 'raw',
    provider,
    value: jsonValue(value),
  } as OutputItem;
}

export function refusalOutput(message: string, providerData?: unknown): OutputItem {
  return {
    type: 'refusal',
    role: 'assistant',
    message,
    ...(providerData === undefined ? {} : { providerData: jsonValue(providerData) }),
  } as OutputItem;
}

export function usageFromProvider(
  providerUsage: unknown,
  mapping: {
    readonly input: readonly string[];
    readonly output: readonly string[];
    readonly total?: readonly string[];
    readonly cachedInput?: readonly string[];
    readonly cacheWrite?: readonly string[];
    readonly reasoning?: readonly string[];
  },
): Usage {
  const record = isRecord(providerUsage) ? providerUsage : {};
  const inputTokens = numberAt(record, mapping.input) ?? 0;
  const outputTokens = numberAt(record, mapping.output) ?? 0;
  const totalTokens = numberAt(record, mapping.total ?? []) ?? inputTokens + outputTokens;
  const cachedInputTokens = numberAt(record, mapping.cachedInput ?? []) ?? 0;
  const cacheWriteTokens = numberAt(record, mapping.cacheWrite ?? []) ?? 0;
  const reasoningTokens = numberAt(record, mapping.reasoning ?? []) ?? 0;
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  } as Usage;
}

export function zeroUsage(): Usage {
  return {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  } as Usage;
}

export function structuredOutput(
  request: ModelRequest,
  output: readonly OutputItem[],
): JsonValue | undefined {
  if (!request.outputSchema) return undefined;
  const text = output
    .map(item => itemRecord(item))
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('');
  if (!text) return undefined;
  try {
    return jsonValue(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function attachStructuredOutput(
  request: ModelRequest,
  output: OutputItem[],
): JsonValue | undefined {
  const value = structuredOutput(request, output);
  if (value !== undefined) {
    output.push({
      type: 'structured',
      role: 'assistant',
      value,
      schemaName: request.outputSchema?.name,
    } as OutputItem);
  }
  return value;
}

export function finishReason(value: unknown): ModelFinishReason {
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'completed':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'incomplete':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'refusal':
      return 'refusal';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

export function providerRawInput(item: InputItem): unknown {
  const record = itemRecord(item);
  return record.value;
}

export function jsonObject(value: unknown): JsonObject {
  if (isRecord(value)) return jsonValue(value) as JsonObject;
  if (value === undefined || value === null) return {};
  return { raw: jsonValue(value) };
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(jsonValue) as JsonValue;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    ) as JsonValue;
  }
  return String(value);
}

function numberAt(record: Record<string, unknown>, paths: readonly string[]): number | undefined {
  for (const path of paths) {
    let current: unknown = record;
    for (const segment of path.split('.')) {
      current = isRecord(current) ? current[segment] : undefined;
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
