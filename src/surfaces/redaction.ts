const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS: readonly RegExp[] = Object.freeze([
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^(?:api|access|refresh|auth|id|session)[_-]?token$/i,
  /(?:^|[_-])token$/i,
  /^(?:api|private|secret)[_-]?key$/i,
  /(?:^|[_-])(?:api|private|secret)[_-]?key$/i,
  /^(?:client|shared)?[_-]?secret$/i,
  /(?:^|[_-])secret$/i,
  /^password$/i,
  /^passphrase$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^signature$/i,
  /^stack$/i,
  /^(?:encrypted[_-]?content|opaque(?:[_-]?reasoning)?)$/i,
]);

const ASSIGNMENT_SECRET = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passphrase|client[_-]?secret|private[_-]?key|secret)\s*[=:]\s*)(["']?)([^\s,;"'}]+)/gi;
const QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s#]+/gi;
const AUTHORIZATION_SECRET = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const WELL_KNOWN_TOKEN = /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{4,}\b/g;
const CLOUD_ACCESS_KEY = /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;
const URL_USER_INFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export interface SurfaceRedactionOptions {
  readonly replacement?: string;
  readonly additionalSensitiveKeys?: readonly (string | RegExp)[];
}

/**
 * Produces a JSON-safe clone for an event/surface boundary and removes common
 * credential shapes. It intentionally does not retain Error stacks or opaque
 * reasoning signatures. The source value is never mutated.
 */
export function redactSurfaceValue(
  value: unknown,
  options: SurfaceRedactionOptions = {},
): unknown {
  const replacement = options.replacement ?? REDACTED;
  const keys = [...SENSITIVE_KEYS, ...(options.additionalSensitiveKeys ?? [])];
  return redact(value, replacement, keys, new WeakSet<object>());
}

export function redactSurfaceText(text: string, replacement = REDACTED): string {
  return text
    .replace(AUTHORIZATION_SECRET, (_match, scheme: string) => `${scheme} ${replacement}`)
    .replace(ASSIGNMENT_SECRET, (_match, prefix: string) => `${prefix}${replacement}`)
    .replace(QUERY_SECRET, (_match, prefix: string) => `${prefix}${replacement}`)
    .replace(WELL_KNOWN_TOKEN, replacement)
    .replace(CLOUD_ACCESS_KEY, replacement)
    .replace(URL_USER_INFO, (_match, protocol: string) => `${protocol}${replacement}@`);
}

function redact(
  value: unknown,
  replacement: string,
  keys: readonly (string | RegExp)[],
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactSurfaceText(value, replacement);
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (typeof value !== 'object') return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown };
    return {
      name: redactSurfaceText(error.name, replacement),
      message: redactSurfaceText(error.message, replacement),
      ...(typeof error.code === 'string'
        ? { code: redactSurfaceText(error.code, replacement) }
        : {}),
    };
  }
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map(item => redact(item, replacement, keys, ancestors) ?? null);
    }
    if (value instanceof Map) {
      return [...value.entries()].map(([key, item]) => [
        redact(key, replacement, keys, ancestors),
        redact(item, replacement, keys, ancestors),
      ]);
    }
    if (value instanceof Set) {
      return [...value.values()].map(item => redact(item, replacement, keys, ancestors));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key, keys)) {
        output[key] = replacement;
        continue;
      }
      const redacted = redact(item, replacement, keys, ancestors);
      if (redacted !== undefined) output[key] = redacted;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some(pattern => {
    if (typeof pattern === 'string') return pattern.toLowerCase() === key.toLowerCase();
    pattern.lastIndex = 0;
    return pattern.test(key);
  });
}
