import { randomUUID } from 'node:crypto';

export function createId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function truncateText(value: string, max = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asError(error: unknown): Error & { code?: string } {
  if (error instanceof Error) {
    return error as Error & { code?: string };
  }
  if (typeof error === 'string') {
    return new Error(error) as Error & { code?: string };
  }
  return new Error('Unknown error', { cause: error }) as Error & { code?: string };
}

export function signalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === 'string'
        ? signal.reason
        : 'The run was aborted.';
  throw new Error(reason);
}
