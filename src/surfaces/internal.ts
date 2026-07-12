import { createHash } from 'node:crypto';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  const ancestors = new WeakSet<object>();
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return '[NaN]';
      if (current === Number.POSITIVE_INFINITY) return '[Infinity]';
      if (current === Number.NEGATIVE_INFINITY) return '[-Infinity]';
      return current;
    }
    if (typeof current === 'bigint') return `[BigInt:${current.toString()}]`;
    if (current === undefined) return '[Undefined]';
    if (typeof current === 'function') return `[Function:${current.name}]`;
    if (typeof current === 'symbol') return `[Symbol:${current.description ?? ''}]`;
    if (typeof current !== 'object') return String(current);
    if (current instanceof Date) return `[Date:${current.toISOString()}]`;
    if (current instanceof Error) {
      return { name: current.name, message: current.message, stack: current.stack };
    }
    if (ancestors.has(current)) return '[Circular]';
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map(normalize);
      if (current instanceof Map) {
        return [...current.entries()]
          .map(([key, item]) => [normalize(key), normalize(item)])
          .sort(([left], [right]) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      }
      if (current instanceof Set) {
        return [...current.values()].map(normalize).sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ));
      }
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        output[key] = normalize((current as Record<string, unknown>)[key]);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };
  return JSON.stringify(normalize(value));
}

/** A bounded FIFO identity window, used only to suppress transport replays. */
export class IdentityWindow {
  private readonly values = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('dedupeWindowSize must be a positive safe integer.');
    }
  }

  inspect(key: string, fingerprint: string): 'new' | 'duplicate' | 'collision' {
    const previous = this.values.get(key);
    if (previous !== undefined) return previous === fingerprint ? 'duplicate' : 'collision';
    return 'new';
  }

  remember(key: string, fingerprint: string): void {
    const status = this.inspect(key, fingerprint);
    if (status === 'duplicate') return;
    if (status === 'collision') throw new Error(`Identity "${key}" has conflicting fingerprints.`);
    this.values.set(key, fingerprint);
    this.order.push(key);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  check(key: string, fingerprint: string): 'new' | 'duplicate' | 'collision' {
    const status = this.inspect(key, fingerprint);
    if (status === 'new') this.remember(key, fingerprint);
    return status;
  }

  clear(): void {
    this.values.clear();
    this.order.splice(0);
  }
}
