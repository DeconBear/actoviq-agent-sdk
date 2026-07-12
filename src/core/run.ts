import type { JsonObject } from './json.js';
import type { OutputItem } from './items.js';
import type { Usage } from './usage.js';
import { UsageAccumulator } from './usage.js';

export interface RunContext<TContext = unknown> {
  readonly runId: string;
  readonly agentId: string;
  readonly context: TContext;
  readonly signal: AbortSignal;
  /** ISO-8601 timestamp. */
  readonly startedAt: string;
  /** ISO-8601 timestamp for the effective run deadline. */
  readonly deadlineAt?: string;
  readonly sessionId?: string;
  readonly metadata: JsonObject;
  /** Shared by all model calls belonging to this run. */
  readonly usage: UsageAccumulator;
}

export type RunStatus = 'completed' | 'interrupted' | 'cancelled';

export interface RunResult<TOutput = string> {
  readonly runId: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly output: TOutput;
  readonly items: readonly OutputItem[];
  /** Aggregate of every model call made by this run. */
  readonly usage: Usage;
  /** ISO-8601 timestamp. */
  readonly startedAt: string;
  /** ISO-8601 timestamp. */
  readonly completedAt: string;
  readonly sessionId?: string;
  readonly metadata?: JsonObject;
}
