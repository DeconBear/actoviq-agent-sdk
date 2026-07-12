import { describe, expect, it } from 'vitest';

import {
  UsageAccumulator,
  emptyUsage,
  normalizeUsageDelta,
} from '../src/core/index.js';

describe('UsageAccumulator', () => {
  it('adds every token, cache, request, and cost counter across model calls', () => {
    const usage = new UsageAccumulator();

    usage.add({
      requests: 1,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
      audioInputTokens: 3,
      audioOutputTokens: 2,
      costUsd: 0.0125,
    });
    usage.add({
      requests: 1,
      inputTokens: 70,
      outputTokens: 20,
      totalTokens: 95,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      reasoningTokens: 8,
      audioInputTokens: 1,
      audioOutputTokens: 4,
      costUsd: 0.0075,
    });

    expect(usage.snapshot()).toEqual({
      requests: 2,
      inputTokens: 170,
      outputTokens: 50,
      totalTokens: 225,
      cacheReadTokens: 60,
      cacheWriteTokens: 15,
      reasoningTokens: 20,
      audioInputTokens: 4,
      audioOutputTokens: 6,
      costUsd: 0.02,
    });
  });

  it('supports iterable initialization, immutable snapshots, and reset', () => {
    const usage = new UsageAccumulator([
      { requests: 1, inputTokens: 2, outputTokens: 3 },
      { requests: 1, inputTokens: 5, outputTokens: 7, costUsd: 0.1 },
    ]);

    const snapshot = usage.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.totalTokens).toBe(17);

    usage.add({ outputTokens: 1 });
    expect(snapshot.totalTokens).toBe(17);
    expect(usage.snapshot().totalTokens).toBe(18);

    usage.reset();
    expect(usage.snapshot()).toEqual(emptyUsage());
  });

  it('normalizes atomically and rejects corrupt counters', () => {
    expect(normalizeUsageDelta({ inputTokens: 4, outputTokens: 6 })).toEqual({
      ...emptyUsage(),
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });

    const usage = new UsageAccumulator({ inputTokens: 5 });
    const before = usage.snapshot();

    expect(() => usage.add({ inputTokens: -1 })).toThrow(RangeError);
    expect(() => usage.add({ costUsd: Number.NaN })).toThrow(RangeError);
    expect(() => usage.add({ outputTokens: 1.5 })).toThrow(RangeError);
    expect(usage.snapshot()).toEqual(before);
  });
});
