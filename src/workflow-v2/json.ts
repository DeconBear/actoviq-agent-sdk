import { Buffer } from 'node:buffer';

import {
  WorkflowExecutionError,
  WorkflowMessageLimitError,
  WorkflowOutputLimitError,
  WorkflowProtocolError,
} from './errors.js';
import type { JsonValue } from './types.js';

export function cloneJsonValue(
  value: unknown,
  maxBytes: number,
  kind: 'message' | 'output' = 'message',
): JsonValue {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new WorkflowExecutionError('Workflow value is not JSON serializable.', { cause: error });
  }
  if (json === undefined) {
    throw new WorkflowExecutionError('Workflow value must be a JSON value.');
  }
  assertJsonByteLimit(json, maxBytes, kind);
  return JSON.parse(json) as JsonValue;
}

export function assertJsonByteLimit(
  json: string,
  maxBytes: number,
  kind: 'message' | 'output',
): void {
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return;
  if (kind === 'output') {
    throw new WorkflowOutputLimitError(maxBytes);
  }
  throw new WorkflowMessageLimitError(maxBytes);
}

export function encodeProtocolMessage(message: unknown, maxBytes: number): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(message);
  } catch (error) {
    throw new WorkflowProtocolError('Workflow protocol message is not serializable.', {
      cause: error,
    });
  }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new WorkflowMessageLimitError(maxBytes);
  }
  return `${json}\n`;
}
