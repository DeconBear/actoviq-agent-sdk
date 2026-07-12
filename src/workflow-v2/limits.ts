import { WorkflowConfigurationError } from './errors.js';
import type { WorkflowExecutorLimits } from './types.js';

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKFLOW_MAX_OUTPUT_BYTES = 256 * 1_024;
export const DEFAULT_WORKFLOW_MAX_MESSAGE_BYTES = 1_024 * 1_024;
export const DEFAULT_WORKFLOW_MAX_PROTOCOL_MESSAGES = 1_024;
export const HARD_WORKFLOW_MAX_MESSAGE_BYTES = 16 * 1_024 * 1_024;

export interface ResolvedWorkflowExecutorLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxMessageBytes: number;
  readonly maxProtocolMessages: number;
}

export function resolveWorkflowExecutorLimits(
  limits: WorkflowExecutorLimits = {},
): ResolvedWorkflowExecutorLimits {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_WORKFLOW_MAX_OUTPUT_BYTES;
  const maxMessageBytes = limits.maxMessageBytes ?? DEFAULT_WORKFLOW_MAX_MESSAGE_BYTES;
  const maxProtocolMessages = limits.maxProtocolMessages
    ?? DEFAULT_WORKFLOW_MAX_PROTOCOL_MESSAGES;

  assertPositiveSafeInteger(timeoutMs, 'timeoutMs');
  assertPositiveSafeInteger(maxOutputBytes, 'maxOutputBytes');
  assertPositiveSafeInteger(maxMessageBytes, 'maxMessageBytes');
  assertPositiveSafeInteger(maxProtocolMessages, 'maxProtocolMessages');
  if (maxMessageBytes > HARD_WORKFLOW_MAX_MESSAGE_BYTES) {
    throw new WorkflowConfigurationError(
      `maxMessageBytes cannot exceed ${HARD_WORKFLOW_MAX_MESSAGE_BYTES}.`,
    );
  }

  return Object.freeze({
    timeoutMs,
    maxOutputBytes,
    maxMessageBytes,
    maxProtocolMessages,
  });
}

export function resolveRunTimeout(
  requestTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  const timeoutMs = requestTimeoutMs ?? defaultTimeoutMs;
  assertPositiveSafeInteger(timeoutMs, 'request.timeoutMs');
  return timeoutMs;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowConfigurationError(`${name} must be a positive safe integer.`);
  }
}
