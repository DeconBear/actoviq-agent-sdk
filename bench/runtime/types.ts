export type RuntimeBenchmarkMode = 'smoke' | 'full';

export type BenchmarkUnit = 'ms' | 'bytes' | 'ratio';

export type BenchmarkMeasure = 'latency' | 'cpu' | 'memory' | 'size' | 'overhead';

export interface RuntimeBenchmarkMetric {
  /** Stable comparison key. Parameters that change the workload belong in `parameters`. */
  readonly id: string;
  readonly scenario: string;
  readonly variant: string;
  readonly measure: BenchmarkMeasure;
  readonly unit: BenchmarkUnit;
  readonly direction: 'lower-is-better' | 'informational';
  readonly regression: boolean;
  readonly samples: readonly number[];
  readonly sampleCount: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  readonly notes?: string;
}

export interface RuntimeBenchmarkInvariant {
  readonly id: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly message?: string;
}

export interface RuntimeBenchmarkWorkload {
  readonly samples: number;
  readonly warmupIterations: number;
  readonly mcpToolCounts: readonly number[];
  readonly sessionItemCounts: readonly number[];
  readonly streamDeltaCount: number;
  readonly streamBufferCapacity: number;
  readonly childCounts: readonly number[];
  readonly compactionToolResults: number;
  readonly compactionPayloadChars: number;
  readonly noNetwork: true;
}

export interface RuntimeBenchmarkEnvironment {
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
}

export interface RuntimeBenchmarkReport {
  readonly schemaVersion: 1;
  readonly suite: 'actoviq-runtime';
  readonly mode: RuntimeBenchmarkMode;
  readonly generatedAt: string;
  readonly configurationFingerprint: string;
  readonly environment: RuntimeBenchmarkEnvironment;
  readonly workload: RuntimeBenchmarkWorkload;
  readonly status: 'passed' | 'failed';
  readonly metrics: readonly RuntimeBenchmarkMetric[];
  readonly invariants: readonly RuntimeBenchmarkInvariant[];
}

export interface RuntimeBenchmarkOptions {
  readonly mode?: RuntimeBenchmarkMode;
  readonly samples?: number;
  readonly warmupIterations?: number;
  readonly mcpToolCounts?: readonly number[];
  readonly sessionItemCounts?: readonly number[];
  readonly streamDeltaCount?: number;
  readonly streamBufferCapacity?: number;
  readonly childCounts?: readonly number[];
  readonly compactionToolResults?: number;
  readonly compactionPayloadChars?: number;
}

export interface BenchmarkRegression {
  readonly metricId: string;
  readonly percentile: 'p50' | 'p95';
  readonly baseline: number;
  readonly current: number;
  readonly changePercent: number;
  readonly thresholdPercent: number;
}

export interface BenchmarkAcknowledgement {
  /** Human-readable reason plus a tracking issue/change reference. */
  readonly reason: string;
}

export interface RuntimeBenchmarkComparison {
  readonly schemaVersion: 1;
  readonly suite: 'actoviq-runtime-comparison';
  readonly thresholdPercent: number;
  readonly status: 'passed' | 'failed' | 'acknowledged';
  readonly comparedMetricCount: number;
  readonly missingBaselineMetricIds: readonly string[];
  readonly regressions: readonly BenchmarkRegression[];
  readonly acknowledgement?: BenchmarkAcknowledgement;
}
