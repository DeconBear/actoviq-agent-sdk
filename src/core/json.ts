/** Values that can be represented without loss by JSON. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

/**
 * Return whether a value is composed only of finite JSON values.
 *
 * JSON.stringify silently drops `undefined`, functions, and symbols, converts
 * non-finite numbers to null, and invokes custom `toJSON` methods. Core state
 * must not depend on those lossy behaviours, so this check is deliberately
 * stricter than JSON.stringify.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>());
}

export function assertJsonValue(
  value: unknown,
  label = 'value',
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${label} must be a finite, acyclic JSON value.`);
  }
}

/** Validate and clone a JSON value through the actual serialization boundary. */
export function cloneJsonValue<T extends JsonValue>(value: T): T {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonValueInternal(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        // JSON.stringify turns sparse slots into null, which is not lossless.
        if (!Object.hasOwn(value, index)) return false;
        if (!isJsonValueInternal(value[index], ancestors)) return false;
      }
      return Reflect.ownKeys(value).every(key => (
        key === 'length'
        || (typeof key === 'string' && isCanonicalArrayIndex(key, value.length))
      ));
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || !isJsonValueInternal(descriptor.value, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key === '') return false;
  const index = Number(key);
  return Number.isSafeInteger(index)
    && index >= 0
    && index < length
    && String(index) === key;
}
