import { createHash } from 'node:crypto';
import os from 'node:os';

import { assertUniqueMetricIds } from './benchmark.js';
import {
  benchmarkBoundedStream,
  benchmarkCompatAdapter,
  benchmarkCompaction,
  benchmarkMcpCatalog,
  benchmarkRuntimeImportAndCreate,
  benchmarkSharedServices,
  benchmarkSqliteSessions,
  type ScenarioResult,
} from './scenarios.js';
import type {
  RuntimeBenchmarkMetric,
  RuntimeBenchmarkOptions,
  RuntimeBenchmarkReport,
  RuntimeBenchmarkWorkload,
} from './types.js';

export async function runRuntimeBenchmarks(
  options: RuntimeBenchmarkOptions = {},
): Promise<RuntimeBenchmarkReport> {
  const mode = options.mode ?? 'smoke';
  const workload = resolveWorkload(mode, options);
  const results: ScenarioResult[] = [];

  // Run sequentially: concurrent scenarios would contaminate CPU, heap, and I/O samples.
  results.push(await benchmarkRuntimeImportAndCreate(workload));
  results.push(await benchmarkMcpCatalog(workload));
  results.push(await benchmarkSqliteSessions(workload));
  results.push(await benchmarkBoundedStream(workload));
  results.push(await benchmarkSharedServices(workload));
  results.push(await benchmarkCompaction(workload));
  results.push(await benchmarkCompatAdapter(workload));

  const metrics = results.flatMap(result => result.metrics);
  const invariants = results.flatMap(result => result.invariants);
  assertUniqueMetricIds(metrics);
  const report: RuntimeBenchmarkReport = {
    schemaVersion: 1,
    suite: 'actoviq-runtime',
    mode,
    generatedAt: new Date().toISOString(),
    configurationFingerprint: fingerprint(workload),
    environment: benchmarkEnvironment(),
    workload,
    status: invariants.every(item => item.passed) ? 'passed' : 'failed',
    metrics,
    invariants,
  };
  assertRuntimeBenchmarkReport(report);
  return report;
}

export function resolveWorkload(
  mode: RuntimeBenchmarkReport['mode'],
  options: RuntimeBenchmarkOptions = {},
): RuntimeBenchmarkWorkload {
  const defaults = mode === 'full'
    ? {
        samples: 7,
        warmupIterations: 2,
        sessionItemCounts: [10_000, 100_000],
        streamDeltaCount: 1_000_000,
        compactionToolResults: 256,
        compactionPayloadChars: 4_096,
      }
    : {
        samples: 3,
        warmupIterations: 1,
        sessionItemCounts: [500],
        streamDeltaCount: 100_000,
        compactionToolResults: 32,
        compactionPayloadChars: 2_048,
      };
  const workload: RuntimeBenchmarkWorkload = {
    samples: options.samples ?? defaults.samples,
    warmupIterations: options.warmupIterations ?? defaults.warmupIterations,
    mcpToolCounts: options.mcpToolCounts ?? [1, 10, 100],
    sessionItemCounts: options.sessionItemCounts ?? defaults.sessionItemCounts,
    streamDeltaCount: options.streamDeltaCount ?? defaults.streamDeltaCount,
    streamBufferCapacity: options.streamBufferCapacity ?? 256,
    childCounts: options.childCounts ?? [1, 4, 8, 16],
    compactionToolResults: options.compactionToolResults ?? defaults.compactionToolResults,
    compactionPayloadChars: options.compactionPayloadChars ?? defaults.compactionPayloadChars,
    noNetwork: true,
  };
  validateWorkload(workload);
  return Object.freeze({
    ...workload,
    mcpToolCounts: Object.freeze([...workload.mcpToolCounts]),
    sessionItemCounts: Object.freeze([...workload.sessionItemCounts]),
    childCounts: Object.freeze([...workload.childCounts]),
  });
}

export function assertRuntimeBenchmarkReport(
  value: unknown,
): asserts value is RuntimeBenchmarkReport {
  if (!isRecord(value)) throw new TypeError('Benchmark report must be an object.');
  if (value.schemaVersion !== 1 || value.suite !== 'actoviq-runtime') {
    throw new TypeError('Unsupported runtime benchmark report schema.');
  }
  if (value.mode !== 'smoke' && value.mode !== 'full') {
    throw new TypeError('Runtime benchmark report mode is invalid.');
  }
  if (value.status !== 'passed' && value.status !== 'failed') {
    throw new TypeError('Runtime benchmark report status is invalid.');
  }
  if (!Array.isArray(value.metrics) || !Array.isArray(value.invariants)) {
    throw new TypeError('Runtime benchmark report requires metrics and invariants arrays.');
  }
  const ids = new Set<string>();
  for (const candidate of value.metrics) {
    assertMetric(candidate);
    if (ids.has(candidate.id)) throw new TypeError(`Duplicate metric id ${candidate.id}.`);
    ids.add(candidate.id);
  }
  for (const candidate of value.invariants) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.passed !== 'boolean'
      || typeof candidate.expected !== 'string'
      || typeof candidate.actual !== 'string') {
      throw new TypeError('Runtime benchmark invariant is invalid.');
    }
  }
}

function assertMetric(value: unknown): asserts value is RuntimeBenchmarkMetric {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.scenario !== 'string'
    || typeof value.variant !== 'string'
    || !Array.isArray(value.samples)
    || value.samples.length < 1
    || value.sampleCount !== value.samples.length) {
    throw new TypeError('Runtime benchmark metric is invalid.');
  }
  for (const field of ['min', 'max', 'p50', 'p95'] as const) {
    if (!isFiniteNonNegative(value[field])) {
      throw new TypeError(`Runtime benchmark metric ${value.id} has invalid ${field}.`);
    }
  }
  if (!value.samples.every(isFiniteNonNegative)) {
    throw new TypeError(`Runtime benchmark metric ${value.id} has invalid samples.`);
  }
}

function validateWorkload(workload: RuntimeBenchmarkWorkload): void {
  positive(workload.samples, 'samples');
  nonNegative(workload.warmupIterations, 'warmupIterations');
  positive(workload.streamDeltaCount, 'streamDeltaCount');
  positive(workload.streamBufferCapacity, 'streamBufferCapacity');
  positive(workload.compactionToolResults, 'compactionToolResults');
  positive(workload.compactionPayloadChars, 'compactionPayloadChars');
  positiveList(workload.mcpToolCounts, 'mcpToolCounts');
  positiveList(workload.sessionItemCounts, 'sessionItemCounts');
  positiveList(workload.childCounts, 'childCounts');
}

function positiveList(values: readonly number[], name: string): void {
  if (values.length === 0) throw new RangeError(`${name} must not be empty.`);
  for (const value of values) positive(value, name);
  if (new Set(values).size !== values.length) throw new RangeError(`${name} must be unique.`);
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must contain positive safe integers.`);
  }
}

function nonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function fingerprint(workload: RuntimeBenchmarkWorkload): string {
  return createHash('sha256').update(JSON.stringify(workload)).digest('hex');
}

function benchmarkEnvironment(): RuntimeBenchmarkReport['environment'] {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
