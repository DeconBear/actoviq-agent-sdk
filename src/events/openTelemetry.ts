import type { EventSink, RunEvent } from './runEvents.js';

export interface OpenTelemetrySpanEvent {
  readonly name: string;
  readonly time: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Dependency-free span DTO shaped for an OpenTelemetry exporter adapter. */
export interface OpenTelemetryReadableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly status: { readonly code: 'UNSET' | 'OK' | 'ERROR'; readonly message?: string };
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly OpenTelemetrySpanEvent[];
}

export interface OpenTelemetryExportResult {
  readonly code: 0 | 1;
  readonly error?: Error;
}

/** Matches the callback/export lifecycle of OpenTelemetry JS SpanExporter. */
export interface OpenTelemetryCompatibleExporter {
  export(
    spans: readonly OpenTelemetryReadableSpan[],
    resultCallback: (result: OpenTelemetryExportResult) => void,
  ): void;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface OpenTelemetryRunEventSinkOptions {
  readonly exporter: OpenTelemetryCompatibleExporter;
  readonly maxBufferedEventsPerRun?: number;
  readonly serviceName?: string;
}

interface PendingSpan {
  first: RunEvent;
  last: RunEvent;
  events: OpenTelemetrySpanEvent[];
  droppedEvents: number;
}

/** Converts one run's versioned event stream into one exportable trace span. */
export class OpenTelemetryRunEventSink implements EventSink {
  readonly id = 'opentelemetry';
  private readonly pending = new Map<string, PendingSpan>();
  private readonly seenEvents = new Set<string>();
  private readonly exporter: OpenTelemetryCompatibleExporter;
  private readonly maxBufferedEventsPerRun: number;
  private readonly serviceName: string;
  private closed = false;

  constructor(options: OpenTelemetryRunEventSinkOptions) {
    if (!Number.isSafeInteger(options.maxBufferedEventsPerRun ?? 256)
      || (options.maxBufferedEventsPerRun ?? 256) < 1) {
      throw new RangeError('maxBufferedEventsPerRun must be a positive safe integer.');
    }
    this.exporter = options.exporter;
    this.maxBufferedEventsPerRun = options.maxBufferedEventsPerRun ?? 256;
    this.serviceName = options.serviceName ?? 'actoviq-agent-sdk';
  }

  async write(event: RunEvent): Promise<void> {
    if (this.closed) throw new Error('OpenTelemetryRunEventSink is closed.');
    if (this.seenEvents.has(event.eventId)) return;
    this.seenEvents.add(event.eventId);

    let span = this.pending.get(event.runId);
    if (!span) {
      span = { first: event, last: event, events: [], droppedEvents: 0 };
      this.pending.set(event.runId, span);
    }
    if (event.sequence <= span.last.sequence && event !== span.first) {
      throw new Error(`Run ${event.runId} emitted non-monotonic trace event ${event.sequence}.`);
    }
    span.last = event;
    span.events.push(toSpanEvent(event));
    if (span.events.length > this.maxBufferedEventsPerRun) {
      span.events.shift();
      span.droppedEvents += 1;
    }

    if (isTerminalEvent(event.type)) {
      this.pending.delete(event.runId);
      await this.exportSpan(toReadableSpan(span, this.serviceName));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const incomplete = [...this.pending.values()];
    this.pending.clear();
    for (const span of incomplete) {
      await this.exportSpan(toReadableSpan(span, this.serviceName, true));
    }
    await this.exporter.forceFlush?.();
    await this.exporter.shutdown?.();
  }

  private exportSpan(span: OpenTelemetryReadableSpan): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.exporter.export([span], result => {
        if (settled) return;
        settled = true;
        if (result.code === 0) resolve();
        else reject(result.error ?? new Error('OpenTelemetry exporter failed.'));
      });
    });
  }
}

function toSpanEvent(event: RunEvent): OpenTelemetrySpanEvent {
  return {
    name: event.type,
    time: event.timestamp,
    attributes: {
      'actoviq.event.id': event.eventId,
      'actoviq.event.sequence': event.sequence,
      'actoviq.event.schema_version': event.schemaVersion,
      'actoviq.event.data': event.data,
    },
  };
}

function toReadableSpan(
  span: PendingSpan,
  serviceName: string,
  incomplete = false,
): OpenTelemetryReadableSpan {
  const terminal = span.last.type;
  const isError = terminal === 'run.failed' || terminal === 'run.error';
  const isSuccess = terminal === 'run.completed';
  return {
    name: `agent.run ${span.first.runId}`,
    traceId: span.first.traceId,
    spanId: span.first.spanId,
    parentSpanId: span.first.parentSpanId,
    startTime: span.first.timestamp,
    endTime: span.last.timestamp,
    status: isError
      ? { code: 'ERROR', message: terminal }
      : isSuccess
        ? { code: 'OK' }
        : { code: 'UNSET', ...(incomplete ? { message: 'incomplete' } : {}) },
    attributes: {
      'service.name': serviceName,
      'actoviq.run.id': span.first.runId,
      ...(span.first.parentRunId ? { 'actoviq.run.parent_id': span.first.parentRunId } : {}),
      'actoviq.events.dropped': span.droppedEvents,
      'actoviq.run.incomplete': incomplete,
    },
    events: Object.freeze([...span.events]),
  };
}

function isTerminalEvent(type: string): boolean {
  return type === 'run.completed'
    || type === 'run.failed'
    || type === 'run.error'
    || type === 'run.cancelled'
    || type === 'run.interrupted';
}
