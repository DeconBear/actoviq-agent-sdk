import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { percentile } from '../bench/runtime/benchmark.js';
import {
  assertRuntimeBenchmarkReport,
  resolveWorkload,
  runRuntimeBenchmarks,
} from '../bench/runtime/suite.js';

describe('runtime benchmark harness', () => {
  it('uses the documented full workloads', () => {
    const workload = resolveWorkload('full');
    expect(workload.sessionItemCounts).toEqual([10_000, 100_000]);
    expect(workload.streamDeltaCount).toBe(1_000_000);
    expect(workload.mcpToolCounts).toEqual([1, 10, 100]);
    expect(workload.childCounts).toEqual([1, 4, 8, 16]);
    expect(workload.noNetwork).toBe(true);
  });

  it('calculates interpolated percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.95)).toBe(9.5);
  });

  it('runs every scenario in a fast deterministic smoke scale', async () => {
    const report = await runRuntimeBenchmarks({
      mode: 'smoke',
      samples: 2,
      warmupIterations: 0,
      sessionItemCounts: [64],
      streamDeltaCount: 20_000,
      compactionToolResults: 8,
      compactionPayloadChars: 128,
    });

    expect(report.status).toBe('passed');
    expect(report.workload.noNetwork).toBe(true);
    expect(report.invariants.every(item => item.passed)).toBe(true);
    expect(report.metrics.every(item =>
      item.sampleCount === 2
      && Number.isFinite(item.p50)
      && Number.isFinite(item.p95))).toBe(true);

    const ids = new Set(report.metrics.map(item => item.id));
    for (const required of [
      'runtime.import_create.cold',
      'runtime.import_create.warm',
      'mcp.catalog.tools_1.cold',
      'mcp.catalog.tools_10.warm',
      'mcp.catalog.tools_100.cold',
      'storage.sqlite.items_64.append',
      'storage.sqlite.items_64.load_full',
      'storage.sqlite.items_64.snapshot',
      'storage.sqlite.items_64.load_snapshot',
      'stream.delta.bounded.duration',
      'orchestration.shared_services.children_1',
      'orchestration.shared_services.children_4',
      'orchestration.shared_services.children_8',
      'orchestration.shared_services.children_16',
      'compaction.request.before.cpu',
      'compaction.request.after.bytes',
      'compat.runtime.direct',
      'compat.runtime.adapter',
      'compat.runtime.overhead_ratio',
    ]) {
      expect(ids.has(required), `missing ${required}`).toBe(true);
    }

    const roundTripped = JSON.parse(JSON.stringify(report)) as unknown;
    expect(() => assertRuntimeBenchmarkReport(roundTripped)).not.toThrow();
  }, 30_000);

  it('ships a versioned JSON Schema', async () => {
    const filename = fileURLToPath(new URL(
      '../bench/runtime/report.schema.json',
      import.meta.url,
    ));
    const schema = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://actoviq.dev/schemas/runtime-benchmark-report-v1.json');
  });
});
