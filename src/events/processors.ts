import type { EventProcessor, RunEvent } from './runEvents.js';

export interface SensitiveDataRedactionOptions {
  readonly replacement?: string;
  readonly additionalKeys?: readonly (string | RegExp)[];
}

const DEFAULT_SENSITIVE_KEYS: readonly RegExp[] = Object.freeze([
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^(?:api|access|refresh|auth)[_-]?token$/i,
  /^(?:api|private|secret)[_-]?key$/i,
  /^(?:client|shared)?[_-]?secret$/i,
  /^password$/i,
  /^cookie$/i,
  /^set-cookie$/i,
]);

/** Redacts secret-bearing object fields before events cross a sink boundary. */
export class SensitiveDataRedactionProcessor implements EventProcessor {
  readonly id = 'sensitive-data-redaction';
  private readonly replacement: string;
  private readonly keys: readonly (string | RegExp)[];

  constructor(options: SensitiveDataRedactionOptions = {}) {
    this.replacement = options.replacement ?? '[REDACTED]';
    this.keys = [...DEFAULT_SENSITIVE_KEYS, ...(options.additionalKeys ?? [])];
  }

  process(event: RunEvent): RunEvent {
    return { ...event, data: redactValue(event.data, this.keys, this.replacement, new WeakMap()) };
  }
}

function redactValue(
  value: unknown,
  keys: readonly (string | RegExp)[],
  replacement: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (Array.isArray(value)) {
    const previous = seen.get(value);
    if (previous) return previous;
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(redactValue(item, keys, replacement, seen));
    return clone;
  }
  if (!isPlainObject(value)) return value;

  const previous = seen.get(value);
  if (previous) return previous;
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = isSensitiveKey(key, keys)
      ? replacement
      : redactValue(item, keys, replacement, seen);
  }
  return clone;
}

function isSensitiveKey(key: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some(pattern => typeof pattern === 'string'
    ? pattern.toLowerCase() === key.toLowerCase()
    : pattern.test(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
