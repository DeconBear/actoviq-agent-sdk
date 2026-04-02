import type {
  ActoviqHooks,
  ActoviqPostSamplingHook,
  ActoviqPostRunHook,
  ActoviqSessionStartHook,
} from '../types.js';
import type { MessageParam } from '../provider/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMessages(messages: MessageParam[] | undefined): MessageParam[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.filter(
    (message): message is MessageParam =>
      isRecord(message) &&
      (message.role === 'user' || message.role === 'assistant') &&
      (typeof message.content === 'string' || Array.isArray(message.content)),
  );
}

export function mergeActoviqHooks(
  base: ActoviqHooks | undefined,
  extra: ActoviqHooks | undefined,
): ActoviqHooks | undefined {
  const sessionStart = [
    ...(base?.sessionStart ?? []),
    ...(extra?.sessionStart ?? []),
  ];
  const postSampling = [
    ...(base?.postSampling ?? []),
    ...(extra?.postSampling ?? []),
  ];
  const postRun = [
    ...(base?.postRun ?? []),
    ...(extra?.postRun ?? []),
  ];

  if (sessionStart.length === 0 && postSampling.length === 0 && postRun.length === 0) {
    return undefined;
  }

  return {
    sessionStart: sessionStart.length > 0 ? sessionStart : undefined,
    postSampling: postSampling.length > 0 ? postSampling : undefined,
    postRun: postRun.length > 0 ? postRun : undefined,
  };
}

export function resolveActoviqSessionStartHooks(hooks?: ActoviqHooks): ActoviqSessionStartHook[] {
  return hooks?.sessionStart ?? [];
}

export function resolveActoviqPostRunHooks(hooks?: ActoviqHooks): ActoviqPostRunHook[] {
  return hooks?.postRun ?? [];
}

export function resolveActoviqPostSamplingHooks(
  hooks?: ActoviqHooks,
): ActoviqPostSamplingHook[] {
  return hooks?.postSampling ?? [];
}

export function normalizeActoviqHookMessages(messages: MessageParam[] | undefined): MessageParam[] {
  return normalizeMessages(messages);
}
