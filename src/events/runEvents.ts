import { randomBytes, randomUUID } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface RunEvent<TData = unknown> extends TraceContext {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  runId: string;
  parentRunId?: string;
  type: string;
  timestamp: string;
  data: TData;
}

export interface RunEventContext extends TraceContext {
  runId: string;
  parentRunId?: string;
}

export interface EventSink {
  readonly id: string;
  write(event: RunEvent): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface EventProcessor {
  readonly id: string;
  process(event: RunEvent): Promise<RunEvent | null> | RunEvent | null;
}

export interface EventDispatcherOptions {
  processors?: readonly EventProcessor[];
  sinks?: readonly EventSink[];
  failureMode?: 'throw' | 'isolate';
  onSinkError?: (sink: EventSink, error: unknown, event: RunEvent) => void;
  onProcessorError?: (processor: EventProcessor, error: unknown, event: RunEvent) => void;
}

/** Creates versioned, monotonically sequenced events for exactly one run. */
export class RunEventSequencer {
  private sequence: number;

  constructor(
    readonly context: RunEventContext,
    lastCommittedSequence = 0,
  ) {
    if (!Number.isSafeInteger(lastCommittedSequence) || lastCommittedSequence < 0) {
      throw new RangeError('lastCommittedSequence must be a non-negative safe integer.');
    }
    this.sequence = lastCommittedSequence;
  }

  next<TData>(type: string, data: TData, timestamp = new Date().toISOString()): RunEvent<TData> {
    if (!type.trim()) throw new Error('Run event type must not be empty.');
    this.sequence += 1;
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: this.sequence,
      runId: this.context.runId,
      parentRunId: this.context.parentRunId,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      type,
      timestamp,
      data,
    };
  }

  get lastSequence(): number {
    return this.sequence;
  }
}

/** Awaited processor/sink pipeline: sink speed applies backpressure to the run. */
export class EventDispatcher {
  private readonly processors: readonly EventProcessor[];
  private readonly sinks: readonly EventSink[];
  private readonly failureMode: 'throw' | 'isolate';
  private readonly onSinkError?: EventDispatcherOptions['onSinkError'];
  private readonly onProcessorError?: EventDispatcherOptions['onProcessorError'];
  private closed = false;

  constructor(options: EventDispatcherOptions = {}) {
    this.processors = [...(options.processors ?? [])];
    this.sinks = [...(options.sinks ?? [])];
    this.failureMode = options.failureMode ?? 'throw';
    this.onSinkError = options.onSinkError;
    this.onProcessorError = options.onProcessorError;
    assertUniqueIds(this.processors, 'processor');
    assertUniqueIds(this.sinks, 'sink');
  }

  async dispatch(event: RunEvent): Promise<RunEvent | null> {
    if (this.closed) throw new Error('EventDispatcher is closed.');
    let current: RunEvent | null = event;
    for (const processor of this.processors) {
      if (!current) break;
      const source = current;
      try {
        current = await processor.process(source);
      } catch (error) {
        this.onProcessorError?.(processor, error, source);
        if (this.failureMode === 'throw') throw error;
      }
    }
    if (!current) return null;

    for (const sink of this.sinks) {
      try {
        await sink.write(current);
      } catch (error) {
        this.onSinkError?.(sink, error, current);
        if (this.failureMode === 'throw') throw error;
      }
    }
    return current;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(this.sinks.map(sink => sink.close?.()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more event sinks failed to close.');
    }
  }
}

/** Test/local sink with event-id deduplication and per-run sequence validation. */
export class InMemoryEventSink implements EventSink {
  readonly id = 'memory';
  private readonly eventIds = new Set<string>();
  private readonly lastSequenceByRun = new Map<string, number>();
  readonly events: RunEvent[] = [];

  write(event: RunEvent): void {
    if (this.eventIds.has(event.eventId)) return;
    const previous = this.lastSequenceByRun.get(event.runId) ?? 0;
    if (event.sequence <= previous) {
      throw new Error(
        `Run ${event.runId} event sequence ${event.sequence} is not greater than ${previous}.`,
      );
    }
    this.eventIds.add(event.eventId);
    this.lastSequenceByRun.set(event.runId, event.sequence);
    this.events.push(structuredClone(event));
  }
}

export function createRootTraceContext(runId: string): RunEventContext {
  return {
    runId,
    traceId: randomHex(16),
    spanId: randomHex(8),
  };
}

export function createChildTraceContext(
  runId: string,
  parentRunId: string,
  parent: TraceContext,
): RunEventContext {
  return {
    runId,
    parentRunId,
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId,
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function assertUniqueIds(items: readonly { id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id.trim()) throw new Error(`Event ${kind} id must not be empty.`);
    if (seen.has(item.id)) throw new Error(`Duplicate event ${kind} id "${item.id}".`);
    seen.add(item.id);
  }
}
