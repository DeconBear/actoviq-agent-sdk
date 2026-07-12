import { describe, expect, it } from 'vitest';

import { compareRuntimeBenchmarkReports } from '../bench/runtime/comparison.js';
import type { RuntimeBenchmarkReport } from '../bench/runtime/types.js';

describe('runtime benchmark regression comparison', () => {
  it('flags p50/p95 changes greater than ten percent', () => {
    const baseline = reportWithTiming(100, 100);
    const current = reportWithTiming(111, 111);
    const comparison = compareRuntimeBenchmarkReports(current, baseline);

    expect(comparison.status).toBe('failed');
    expect(comparison.regressions.map(item => item.percentile)).toEqual(['p50', 'p95']);
    expect(comparison.regressions.every(item => item.changePercent === 11)).toBe(true);
  });

  it('does not flag exactly ten percent and supports documented acknowledgement', () => {
    expect(compareRuntimeBenchmarkReports(
      reportWithTiming(110, 110),
      reportWithTiming(100, 100),
    ).status).toBe('passed');

    const acknowledged = compareRuntimeBenchmarkReports(
      reportWithTiming(120, 120),
      reportWithTiming(100, 100),
      { acknowledgement: { reason: 'Accepted for ACT-123 after security hardening' } },
    );
    expect(acknowledged.status).toBe('acknowledged');
    expect(acknowledged.acknowledgement?.reason).toContain('ACT-123');
    expect(acknowledged.regressions).toHaveLength(2);
  });

  it('rejects undocumented acknowledgements', () => {
    expect(() => compareRuntimeBenchmarkReports(
      reportWithTiming(120, 120),
      reportWithTiming(100, 100),
      { acknowledgement: { reason: 'ok' } },
    )).toThrow(/document a reason/i);
  });
});

function reportWithTiming(p50: number, p95: number): RuntimeBenchmarkReport {
  return {
    schemaVersion: 1,
    suite: 'actoviq-runtime',
    mode: 'smoke',
    generatedAt: '2026-01-01T00:00:00.000Z',
    configurationFingerprint: '0'.repeat(64),
    environment: {
      node: 'v22.0.0',
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'test',
      cpuCount: 1,
      totalMemoryBytes: 1,
    },
    workload: {
      samples: 2,
      warmupIterations: 0,
      mcpToolCounts: [1],
      sessionItemCounts: [1],
      streamDeltaCount: 1,
      streamBufferCapacity: 1,
      childCounts: [1],
      compactionToolResults: 1,
      compactionPayloadChars: 1,
      noNetwork: true,
    },
    status: 'passed',
    metrics: [{
      id: 'runtime.test',
      scenario: 'test',
      variant: 'test',
      measure: 'latency',
      unit: 'ms',
      direction: 'lower-is-better',
      regression: true,
      samples: [p50, p95],
      sampleCount: 2,
      min: Math.min(p50, p95),
      max: Math.max(p50, p95),
      p50,
      p95,
    }],
    invariants: [{ id: 'test', passed: true, expected: 'true', actual: 'true' }],
  };
}
