import { describe, expect, it, vi } from 'vitest';

import {
  createChildTraceContext,
  createRootTraceContext,
  EventDispatcher,
  InMemoryEventSink,
  RunEventSequencer,
} from '../src/events/runEvents.js';
import { OpenTelemetryRunEventSink } from '../src/events/openTelemetry.js';
import { SensitiveDataRedactionProcessor } from '../src/events/processors.js';

describe('run event envelope', () => {
  it('assigns monotonic sequence and reconstructable parent/child trace context', () => {
    const root = createRootTraceContext('root');
    const child = createChildTraceContext('child', 'root', root);
    const sequencer = new RunEventSequencer(child, 4);
    const first = sequencer.next('run.started', {});
    const second = sequencer.next('model.completed', { text: 'ok' });

    expect([first.sequence, second.sequence]).toEqual([5, 6]);
    expect(first).toMatchObject({
      schemaVersion: 1,
      runId: 'child',
      parentRunId: 'root',
      traceId: root.traceId,
      parentSpanId: root.spanId,
      spanId: child.spanId,
    });
    expect(first.eventId).not.toBe(second.eventId);
  });

  it('awaits processors and sinks, supports redaction/drop, and deduplicates event ids', async () => {
    const sink = new InMemoryEventSink();
    const writeSpy = vi.spyOn(sink, 'write');
    const dispatcher = new EventDispatcher({
      processors: [{
        id: 'redact',
        process: async event => event.type === 'secret'
          ? null
          : { ...event, data: { redacted: true } },
      }],
      sinks: [sink],
    });
    const sequencer = new RunEventSequencer(createRootTraceContext('run'));
    const visible = sequencer.next('visible', { token: 'secret' });

    await dispatcher.dispatch(visible);
    await dispatcher.dispatch({ ...visible });
    await expect(dispatcher.dispatch(sequencer.next('secret', {}))).resolves.toBeNull();
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.data).toEqual({ redacted: true });
    await dispatcher.close();
  });

  it('can isolate sink failures without hiding them from diagnostics', async () => {
    const errors: unknown[] = [];
    const memory = new InMemoryEventSink();
    const dispatcher = new EventDispatcher({
      failureMode: 'isolate',
      sinks: [
        { id: 'broken', write: () => { throw new Error('sink down'); } },
        memory,
      ],
      onSinkError: (_sink, error) => errors.push(error),
    });
    const event = new RunEventSequencer(createRootTraceContext('run')).next('event', {});

    await expect(dispatcher.dispatch(event)).resolves.toEqual(event);
    expect(errors).toHaveLength(1);
    expect(memory.events).toHaveLength(1);
  });

  it('can isolate optional processor failures while reporting diagnostics', async () => {
    const errors: unknown[] = [];
    const sink = new InMemoryEventSink();
    const dispatcher = new EventDispatcher({
      failureMode: 'isolate',
      processors: [
        { id: 'broken', process: () => { throw new Error('processor down'); } },
        { id: 'next', process: event => ({ ...event, data: { observed: true } }) },
      ],
      sinks: [sink],
      onProcessorError: (_processor, error) => errors.push(error),
    });
    const event = new RunEventSequencer(createRootTraceContext('run')).next('event', {});

    await dispatcher.dispatch(event);
    expect(errors).toHaveLength(1);
    expect(sink.events[0]?.data).toEqual({ observed: true });
  });

  it('redacts nested credentials without mutating the source event', async () => {
    const processor = new SensitiveDataRedactionProcessor();
    const original = new RunEventSequencer(createRootTraceContext('run')).next('model.request', {
      headers: { authorization: 'Bearer value', harmless: 'visible' },
      apiKey: 'secret',
      nested: [{ password: 'password' }],
    });

    const processed = processor.process(original);
    expect(processed.data).toEqual({
      headers: { authorization: '[REDACTED]', harmless: 'visible' },
      apiKey: '[REDACTED]',
      nested: [{ password: '[REDACTED]' }],
    });
    expect(original.data).toMatchObject({ apiKey: 'secret' });
  });

  it('keeps ordinary text content-scanning outside the default key-based policy', () => {
    const processor = new SensitiveDataRedactionProcessor();
    const original = new RunEventSequencer(createRootTraceContext('run')).next('model.text', {
      text: 'A credential copied into ordinary prose is host-controlled content.',
      apiKey: 'secret-value',
    });

    const processed = processor.process(original);
    expect(processed.data).toEqual({
      text: 'A credential copied into ordinary prose is host-controlled content.',
      apiKey: '[REDACTED]',
    });
  });

  it('applies awaited backpressure when a sink is slow', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn(() => blocked);
    const dispatcher = new EventDispatcher({ sinks: [{ id: 'slow', write }] });
    const event = new RunEventSequencer(createRootTraceContext('run')).next('event', {});

    let settled = false;
    const dispatch = dispatcher.dispatch(event).finally(() => { settled = true; });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await expect(dispatch).resolves.toEqual(event);
    expect(settled).toBe(true);
    await dispatcher.close();
  });

  it('exports reconstructable parent/child OpenTelemetry-compatible spans', async () => {
    const spans: unknown[] = [];
    const exporter = {
      export: (batch: readonly unknown[], callback: (result: { code: 0 }) => void) => {
        spans.push(...batch);
        callback({ code: 0 });
      },
    };
    const root = createRootTraceContext('root');
    const child = createChildTraceContext('child', 'root', root);
    const sequencer = new RunEventSequencer(child);
    const sink = new OpenTelemetryRunEventSink({ exporter, maxBufferedEventsPerRun: 2 });

    await sink.write(sequencer.next('run.started', {}));
    await sink.write(sequencer.next('model.completed', {}));
    await sink.write(sequencer.next('run.completed', {}));

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: root.traceId,
      parentSpanId: root.spanId,
      attributes: {
        'actoviq.run.id': 'child',
        'actoviq.run.parent_id': 'root',
        'actoviq.events.dropped': 1,
      },
      status: { code: 'OK' },
    });
    await sink.close();
  });
});
