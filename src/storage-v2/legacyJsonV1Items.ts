import {
  assertJsonValue,
  type DocumentSource,
  type ImageSource,
  type InputItem,
  type JsonObject as CoreJsonObject,
  type JsonValue as CoreJsonValue,
  type MessageRole,
} from '../core/index.js';
import { StorageDataError } from './errors.js';

/**
 * Convert one legacy JSON-v1 MessageParam into provider-neutral conversation items.
 *
 * This is also used by the SQLite runtime adapter so databases produced by an
 * earlier preview (which stored MessageParam verbatim) remain readable.
 */
export function convertLegacyJsonV1Message(
  value: unknown,
  label = 'legacy JSON-v1 message',
): InputItem[] {
  if (!isObject(value) || (value.role !== 'user' && value.role !== 'assistant')) {
    throw invalid(label, 'role must be "user" or "assistant"');
  }
  const role = value.role;
  if (typeof value.content === 'string') {
    return [{ type: 'text', role, text: value.content, metadata: provenance(role, 0) }];
  }
  if (!Array.isArray(value.content)) {
    throw invalid(label, 'content must be a string or an array of content blocks');
  }
  if (value.content.length === 0) {
    return [{ type: 'text', role, text: '', metadata: provenance(role, 0) }];
  }
  return value.content.map((block, index) => convertBlock(block, role, index, label));
}

export function assertLegacyJsonValue(
  value: unknown,
  label: string,
): asserts value is CoreJsonValue {
  try {
    assertJsonValue(value, label);
  } catch (error) {
    throw new StorageDataError(`${label} is not lossless JSON.`, { cause: error });
  }
}

function convertBlock(
  value: unknown,
  role: 'user' | 'assistant',
  index: number,
  label: string,
): InputItem {
  assertLegacyJsonValue(value, `${label}.content[${index}]`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return rawItem(value, role, index);
  }
  const block = value as CoreJsonObject & Record<string, CoreJsonValue>;
  if (typeof block.type !== 'string') return rawItem(block, role, index);
  const metadata = provenance(role, index);
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') throw invalid(label, `content[${index}].text must be a string`);
      return { type: 'text', role, text: block.text, metadata };
    case 'thinking': {
      if (typeof block.thinking !== 'string') {
        throw invalid(label, `content[${index}].thinking must be a string`);
      }
      return {
        type: 'reasoning',
        provider: 'legacy',
        summary: block.thinking,
        opaque: redactReasoningCredentials(block),
        metadata,
      };
    }
    case 'tool_use': {
      if (typeof block.id !== 'string' || block.id.length === 0) {
        throw invalid(label, `content[${index}].id must be a non-empty string`);
      }
      if (typeof block.name !== 'string' || block.name.length === 0) {
        throw invalid(label, `content[${index}].name must be a non-empty string`);
      }
      if (!isObject(block.input)) {
        throw invalid(label, `content[${index}].input must be a JSON object`);
      }
      assertLegacyJsonValue(block.input, `${label}.content[${index}].input`);
      const input = block.input as CoreJsonObject;
      return { type: 'tool_call', id: block.id, name: block.name, input, metadata };
    }
    case 'tool_result': {
      if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length === 0) {
        throw invalid(label, `content[${index}].tool_use_id must be a non-empty string`);
      }
      const output = block.content ?? null;
      assertLegacyJsonValue(output, `${label}.content[${index}].content`);
      return {
        type: 'tool_result',
        callId: block.tool_use_id,
        status: block.is_error === true ? 'error' : 'success',
        output,
        metadata,
      };
    }
    case 'document': {
      const source = parseDocumentSource(block.source);
      return source
        ? {
            type: 'document', role, source,
            ...(typeof block.name === 'string' ? { name: block.name } : {}),
            ...('mediaType' in source ? { mediaType: source.mediaType } : {}),
            metadata,
          }
        : rawItem(block, role, index);
    }
    case 'image': {
      const source = parseImageSource(block.source);
      return source
        ? { type: 'image', role, source, metadata }
        : rawItem(block, role, index);
    }
    default:
      return rawItem(block, role, index);
  }
}

function parseDocumentSource(value: unknown): DocumentSource | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === 'url' && typeof value.url === 'string') {
    return { kind: 'url', url: value.url };
  }
  if (
    value.type === 'base64'
    && typeof value.media_type === 'string'
    && typeof value.data === 'string'
  ) {
    return { kind: 'base64', mediaType: value.media_type, data: value.data };
  }
  const fileId = value.file_id ?? value.fileId;
  return (value.type === 'file' || value.type === 'file_id') && typeof fileId === 'string'
    ? { kind: 'file', fileId }
    : undefined;
}

function parseImageSource(value: unknown): ImageSource | undefined {
  return parseDocumentSource(value);
}

function rawItem(
  value: CoreJsonValue,
  role: 'user' | 'assistant',
  index: number,
): InputItem {
  return {
    type: 'raw',
    provider: 'legacy',
    value: { role, content: value },
    metadata: provenance(role, index),
  };
}

function provenance(role: MessageRole, blockIndex: number): CoreJsonObject {
  return { legacyJsonV1: { role, blockIndex } };
}

function redactReasoningCredentials(value: Record<string, CoreJsonValue>): CoreJsonObject {
  const safe: Record<string, CoreJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'signature' || key === 'encrypted_content') continue;
    safe[key] = entry;
  }
  return safe;
}

function invalid(label: string, reason: string): StorageDataError {
  return new StorageDataError(`Invalid ${label}: ${reason}.`);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
