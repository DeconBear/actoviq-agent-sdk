import type {
  HadamardHooks,
  HadamardPostSamplingHook,
  HadamardPostRunHook,
  HadamardSessionStartHook,
  HadamardStopHook,
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

export function mergeHadamardHooks(
  base: HadamardHooks | undefined,
  extra: HadamardHooks | undefined,
): HadamardHooks | undefined {
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
  const stopHooks = [
    ...(base?.stopHooks ?? []),
    ...(extra?.stopHooks ?? []),
  ];

  if (sessionStart.length === 0 && postSampling.length === 0 && postRun.length === 0 && stopHooks.length === 0) {
    return undefined;
  }

  return {
    sessionStart: sessionStart.length > 0 ? sessionStart : undefined,
    postSampling: postSampling.length > 0 ? postSampling : undefined,
    postRun: postRun.length > 0 ? postRun : undefined,
    stopHooks: stopHooks.length > 0 ? stopHooks : undefined,
  };
}

export function resolveHadamardSessionStartHooks(hooks?: HadamardHooks): HadamardSessionStartHook[] {
  return hooks?.sessionStart ?? [];
}

export function resolveHadamardPostRunHooks(hooks?: HadamardHooks): HadamardPostRunHook[] {
  return hooks?.postRun ?? [];
}

export function resolveHadamardPostSamplingHooks(
  hooks?: HadamardHooks,
): HadamardPostSamplingHook[] {
  return hooks?.postSampling ?? [];
}

export function resolveHadamardStopHooks(
  hooks?: HadamardHooks,
): HadamardStopHook[] {
  return hooks?.stopHooks ?? [];
}

export function normalizeHadamardHookMessages(messages: MessageParam[] | undefined): MessageParam[] {
  return normalizeMessages(messages);
}
