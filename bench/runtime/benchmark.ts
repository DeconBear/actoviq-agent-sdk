import { performance } from 'node:perf_hooks';

import type {
  BenchmarkMeasure,
  BenchmarkUnit,
  RuntimeBenchmarkInvariant,
  RuntimeBenchmarkMetric,
} from './types.js';

export interface MeasureOptions {
  readonly samples: number;
  readonly warmupIterations?: number;
}

export async function measureLatency(
  operation: (iteration: number) => unknown | Promise<unknown>,
  options: MeasureOptions,
): Promise<number[]> {
  validateIterations(options.samples, 'samples');
  const warmups = options.warmupIterations ?? 0;
  validateNonNegativeInteger(warmups, 'warmupIterations');
  for (let index = 0; index < warmups; index += 1) {
    await operation(-(index + 1));
  }
  const values: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const started = performance.now();
    await operation(index);
    values.push(Math.max(0, performance.now() - started));
  }
  return values;
}

export function measureCpu<T>(operation: () => T): { value: T; cpuMs: number } {
  const started = process.cpuUsage();
  const value = operation();
  const elapsed = process.cpuUsage(started);
  return {
    value,
    cpuMs: Math.max(0, (elapsed.user + elapsed.system) / 1_000),
  };
}

export function metric(options: {
  readonly id: string;
  readonly scenario: string;
  readonly variant: string;
  readonly measure: BenchmarkMeasure;
  readonly unit: BenchmarkUnit;
  readonly samples: readonly number[];
  readonly regression?: boolean;
  readonly direction?: RuntimeBenchmarkMetric['direction'];
  readonly parameters?: RuntimeBenchmarkMetric['parameters'];
  readonly notes?: string;
}): RuntimeBenchmarkMetric {
  if (options.samples.length === 0) {
    throw new RangeError(`Metric ${options.id} requires at least one sample.`);
  }
  const samples = options.samples.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Metric ${options.id} has an invalid sample: ${value}.`);
    }
    return value;
  });
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    id: options.id,
    scenario: options.scenario,
    variant: options.variant,
    measure: options.measure,
    unit: options.unit,
    direction: options.direction ?? 'lower-is-better',
    regression: options.regression ?? true,
    samples,
    sampleCount: samples.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

/** Linear interpolation (R-7) over an already sorted, non-empty sample set. */
export function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) throw new RangeError('percentile requires samples.');
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError('quantile must be between zero and one.');
  }
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function invariant(
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  message?: string,
): RuntimeBenchmarkInvariant {
  return {
    id,
    passed,
    expected: printable(expected),
    actual: printable(actual),
    ...(message ? { message } : {}),
  };
}

export function assertUniqueMetricIds(metrics: readonly RuntimeBenchmarkMetric[]): void {
  const seen = new Set<string>();
  for (const item of metrics) {
    if (seen.has(item.id)) throw new Error(`Duplicate benchmark metric id: ${item.id}.`);
    seen.add(item.id);
  }
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function validateIterations(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}
