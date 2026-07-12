export interface Usage {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly audioInputTokens: number;
  readonly audioOutputTokens: number;
  readonly costUsd: number;
}

/** A single provider call may omit counters it cannot report. */
export type UsageDelta = Partial<Usage>;

const USAGE_FIELDS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'audioInputTokens',
  'audioOutputTokens',
  'costUsd',
] as const satisfies readonly (keyof Usage)[];

const INTEGER_USAGE_FIELDS = new Set<keyof Usage>([
  'requests',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'audioInputTokens',
  'audioOutputTokens',
]);

export function emptyUsage(): Usage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  };
}

/**
 * Mutable run-local counter with immutable snapshots.
 *
 * Cache and reasoning counters describe token subsets and therefore do not get
 * added to totalTokens a second time. When a provider omits totalTokens, the
 * delta total is derived from inputTokens + outputTokens.
 */
export class UsageAccumulator {
  private totals: Usage = emptyUsage();

  constructor(initial?: UsageDelta | Iterable<UsageDelta>) {
    if (initial === undefined) return;
    if (isIterable(initial)) {
      this.addAll(initial);
    } else {
      this.add(initial);
    }
  }

  add(delta: UsageDelta): this {
    const normalized = normalizeUsageDelta(delta);
    const current = this.totals;
    this.totals = {
      requests: current.requests + normalized.requests,
      inputTokens: current.inputTokens + normalized.inputTokens,
      outputTokens: current.outputTokens + normalized.outputTokens,
      totalTokens: current.totalTokens + normalized.totalTokens,
      cacheReadTokens: current.cacheReadTokens + normalized.cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + normalized.cacheWriteTokens,
      reasoningTokens: current.reasoningTokens + normalized.reasoningTokens,
      audioInputTokens: current.audioInputTokens + normalized.audioInputTokens,
      audioOutputTokens: current.audioOutputTokens + normalized.audioOutputTokens,
      costUsd: current.costUsd + normalized.costUsd,
    };
    return this;
  }

  addAll(deltas: Iterable<UsageDelta>): this {
    for (const delta of deltas) this.add(delta);
    return this;
  }

  snapshot(): Readonly<Usage> {
    return Object.freeze({ ...this.totals });
  }

  reset(): void {
    this.totals = emptyUsage();
  }
}

export function normalizeUsageDelta(delta: UsageDelta): Usage {
  const normalized = emptyUsage() as { -readonly [Key in keyof Usage]: Usage[Key] };

  for (const field of USAGE_FIELDS) {
    const value = delta[field];
    if (value === undefined) continue;
    assertUsageCounter(field, value);
    normalized[field] = value;
  }

  if (delta.totalTokens === undefined) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }

  return normalized;
}

function assertUsageCounter(field: keyof Usage, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Usage field "${field}" must be a finite, non-negative number.`);
  }
  if (INTEGER_USAGE_FIELDS.has(field) && !Number.isSafeInteger(value)) {
    throw new RangeError(`Usage field "${field}" must be a non-negative safe integer.`);
  }
}

function isIterable(value: UsageDelta | Iterable<UsageDelta>): value is Iterable<UsageDelta> {
  return Symbol.iterator in value;
}
