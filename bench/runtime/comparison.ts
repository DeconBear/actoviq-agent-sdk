import type {
  BenchmarkAcknowledgement,
  BenchmarkRegression,
  RuntimeBenchmarkComparison,
  RuntimeBenchmarkReport,
} from './types.js';
import { assertRuntimeBenchmarkReport } from './suite.js';

export interface CompareRuntimeBenchmarkOptions {
  readonly thresholdPercent?: number;
  readonly acknowledgement?: BenchmarkAcknowledgement;
}

export function compareRuntimeBenchmarkReports(
  currentValue: unknown,
  baselineValue: unknown,
  options: CompareRuntimeBenchmarkOptions = {},
): RuntimeBenchmarkComparison {
  assertRuntimeBenchmarkReport(currentValue);
  assertRuntimeBenchmarkReport(baselineValue);
  const current = currentValue as RuntimeBenchmarkReport;
  const baseline = baselineValue as RuntimeBenchmarkReport;
  const thresholdPercent = options.thresholdPercent ?? 10;
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0) {
    throw new RangeError('Regression threshold must be a finite, non-negative percentage.');
  }
  const acknowledgement = normalizeAcknowledgement(options.acknowledgement);
  const baselineById = new Map(baseline.metrics.map(item => [item.id, item]));
  const regressions: BenchmarkRegression[] = [];
  const missingBaselineMetricIds: string[] = [];
  let comparedMetricCount = 0;

  for (const currentMetric of current.metrics) {
    if (!currentMetric.regression || currentMetric.direction !== 'lower-is-better') continue;
    const baselineMetric = baselineById.get(currentMetric.id);
    if (!baselineMetric) {
      missingBaselineMetricIds.push(currentMetric.id);
      continue;
    }
    if (baselineMetric.unit !== currentMetric.unit
      || baselineMetric.measure !== currentMetric.measure) {
      throw new TypeError(`Metric ${currentMetric.id} changed unit or measure.`);
    }
    comparedMetricCount += 1;
    for (const percentile of ['p50', 'p95'] as const) {
      const changePercent = percentageChange(
        baselineMetric[percentile],
        currentMetric[percentile],
      );
      if (changePercent > thresholdPercent) {
        regressions.push({
          metricId: currentMetric.id,
          percentile,
          baseline: baselineMetric[percentile],
          current: currentMetric[percentile],
          changePercent,
          thresholdPercent,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    suite: 'actoviq-runtime-comparison',
    thresholdPercent,
    status: regressions.length === 0
      ? 'passed'
      : acknowledgement
        ? 'acknowledged'
        : 'failed',
    comparedMetricCount,
    missingBaselineMetricIds: missingBaselineMetricIds.sort(),
    regressions: regressions.sort((left, right) =>
      left.metricId.localeCompare(right.metricId)
      || left.percentile.localeCompare(right.percentile)),
    ...(acknowledgement ? { acknowledgement } : {}),
  };
}

function normalizeAcknowledgement(
  acknowledgement: BenchmarkAcknowledgement | undefined,
): BenchmarkAcknowledgement | undefined {
  if (!acknowledgement) return undefined;
  const reason = acknowledgement.reason.trim();
  if (reason.length < 10) {
    throw new TypeError('Regression acknowledgement must document a reason/reference of at least 10 characters.');
  }
  return { reason };
}

function percentageChange(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return ((current - baseline) / baseline) * 100;
}
