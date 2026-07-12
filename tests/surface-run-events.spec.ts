import { describe, expect, it } from 'vitest';

import { RunEventSequencer, type RunEvent } from '../src/events/runEvents.js';
import {
  LegacyAgentEventRunEventAdapter,
  RunEventLegacyCompatAdapter,
  RunEventSemanticProjector,
  SharedRunEventSurfaceProjector,
  SurfaceEventIdentityCollisionError,
  SurfaceEventSequenceError,
  SurfaceEventTraceError,
  type SurfaceSemanticEvent,
} from '../src/surfaces/index.js';
import type { AgentEvent, AgentRunResult } from '../src/types.js';

const ROOT_TRACE = {
  traceId: 'trace-00000000000000000000000000',
  spanId: 'span-parent-0001',
} as const;

function legacy(value: Record<string, unknown>): AgentEvent {
  return value as unknown as AgentEvent;
}

function runResult(): AgentRunResult {
  return {
    runId: 'parent',
    sessionId: 'session-parent',
    model: 'test-model',
    text: 'done',
    message: {
      id: 'msg-final',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    },
    messages: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 9, output_tokens: 4 },
    requests: [],
    toolCalls: [],
    startedAt: '2026-07-11T00:00:00.000Z',
    completedAt: '2026-07-11T00:00:15.000Z',
  } as AgentRunResult;
}

function mixedLegacyEvents(): {
  events: AgentEvent[];
  duplicate: AgentEvent;
  sensitiveToolCall: AgentEvent;
  signedReasoning: AgentEvent;
} {
  const sensitiveToolCall = legacy({
    type: 'tool.call',
    runId: 'parent',
    iteration: 1,
    call: {
      id: 'call-1',
      name: 'read_secret',
      publicName: 'Read secret',
      provider: 'local',
      input: { path: 'README.md', password: 'hunter2', authorization: 'Bearer raw-token-123' },
      startedAt: '2026-07-11T00:00:07.000Z',
    },
    timestamp: '2026-07-11T00:00:07.000Z',
  });
  const signedReasoning = legacy({
    type: 'response.thinking.delta',
    runId: 'parent',
    iteration: 1,
    index: 0,
    delta: 'check assumptions',
    snapshot: 'check assumptions',
    signature: 'opaque-provider-signature',
    timestamp: '2026-07-11T00:00:04.000Z',
  });
  const duplicate = legacy({
    type: 'response.text.delta',
    runId: 'parent',
    iteration: 1,
    delta: 'hello ',
    snapshot: 'hello ',
    timestamp: '2026-07-11T00:00:03.000Z',
  });
  const events = [
    // Child deliberately arrives before its parent to exercise late trace validation.
    legacy({
      type: 'run.started', runId: 'child', model: 'child-model', input: 'child input',
      timestamp: '2026-07-11T00:00:00.100Z',
    }),
    legacy({
      type: 'run.started', runId: 'parent', sessionId: 'session-parent', model: 'test-model',
      input: 'Authorization: Bearer root-secret-token', timestamp: '2026-07-11T00:00:00.000Z',
    }),
    legacy({
      type: 'request.started', runId: 'parent', iteration: 1, requestTokenEstimate: 42,
      requestByteLength: 512, timestamp: '2026-07-11T00:00:01.000Z',
    }),
    legacy({
      type: 'request.started', runId: 'child', iteration: 1, requestTokenEstimate: 7,
      timestamp: '2026-07-11T00:00:01.100Z',
    }),
    duplicate,
    signedReasoning,
    legacy({
      type: 'model.fallback', runId: 'parent', iteration: 1, fromModel: 'model-a',
      toModel: 'model-b', reason: 'capacity', timestamp: '2026-07-11T00:00:05.000Z',
    }),
    legacy({
      type: 'response.tool_input.delta', runId: 'parent', iteration: 1, index: 1,
      toolUseId: 'call-1', toolName: 'read_secret', delta: '{"path":"README.md"}',
      snapshot: '{"path":"README.md"}', timestamp: '2026-07-11T00:00:06.000Z',
    }),
    sensitiveToolCall,
    legacy({
      type: 'tool.progress', runId: 'parent', iteration: 1, toolUseId: 'call-1',
      data: { type: 'status', message: 'reading', apiKey: 'progress-key' },
      timestamp: '2026-07-11T00:00:08.000Z',
    }),
    legacy({
      type: 'tool.result', runId: 'parent', iteration: 1,
      result: {
        id: 'call-1', name: 'read_secret', publicName: 'Read secret', provider: 'local',
        input: { path: 'README.md', password: 'hunter2' }, output: { value: 'ok', token: 'result-token' },
        outputText: 'ok', isError: false, startedAt: '2026-07-11T00:00:07.000Z',
        completedAt: '2026-07-11T00:00:09.000Z', durationMs: 2000,
      },
      timestamp: '2026-07-11T00:00:09.000Z',
    }),
    legacy({
      type: 'response.content', runId: 'parent', iteration: 1,
      content: { type: 'text', text: 'model content' }, timestamp: '2026-07-11T00:00:10.000Z',
    }),
    legacy({
      type: 'conversation.compacted', runId: 'parent', iteration: 1, trigger: 'auto',
      tokenEstimateBefore: 100, tokenEstimateAfter: 40, messagesSummarized: 6,
      preservedMessages: 2, clearedToolResults: 1, timestamp: '2026-07-11T00:00:11.000Z',
    }),
    legacy({
      type: 'request.interrupted', runId: 'parent', iteration: 1, retry: 1, maxRetries: 2,
      reason: 'steering input', timestamp: '2026-07-11T00:00:12.000Z',
    }),
    legacy({
      type: 'session.compacted', runId: 'child', sessionId: 'session-child', trigger: 'manual',
      result: { messagesRemoved: 3, summary: 'short' }, timestamp: '2026-07-11T00:00:13.000Z',
    }),
    legacy({
      type: 'response.completed', runId: 'parent', result: runResult(),
      timestamp: '2026-07-11T00:00:15.000Z',
    }),
    legacy({
      type: 'error', runId: 'child',
      error: {
        message: 'api_key=sk-proj-super-secret', code: 'CHILD_FAILED',
        stack: 'C:\\secret\\runtime.ts:1',
      },
      timestamp: '2026-07-11T00:00:16.000Z',
    }),
  ];
  return { events, duplicate, sensitiveToolCall, signedReasoning };
}

function adaptMixedStream(): {
  runEvents: RunEvent[];
  adapter: LegacyAgentEventRunEventAdapter;
  fixture: ReturnType<typeof mixedLegacyEvents>;
} {
  const fixture = mixedLegacyEvents();
  const adapter = new LegacyAgentEventRunEventAdapter();
  adapter.registerRootRun('parent', ROOT_TRACE);
  adapter.registerChildRun('child', 'parent', { spanId: 'span-child-00001' });
  const runEvents: RunEvent[] = [];
  for (const event of fixture.events) {
    const adapted = adapter.adapt(event);
    if (adapted) runEvents.push(adapted);
    if (event === fixture.duplicate) {
      expect(adapter.adapt(event)).toBeUndefined();
    }
  }
  return { runEvents, adapter, fixture };
}

describe('surface RunEvent migration', () => {
  it('adapts interleaved legacy runs into versioned, per-run monotonic and redacted events', () => {
    const { runEvents, adapter, fixture } = adaptMixedStream();
    const parent = runEvents.filter(event => event.runId === 'parent');
    const child = runEvents.filter(event => event.runId === 'child');

    expect(parent.map(event => event.sequence)).toEqual(parent.map((_, index) => index + 1));
    expect(child.map(event => event.sequence)).toEqual(child.map((_, index) => index + 1));
    expect(runEvents.every(event => event.schemaVersion === 1 && Boolean(event.eventId))).toBe(true);
    expect(adapter.getLastSequence('parent')).toBe(parent.length);
    expect(adapter.getLastSequence('child')).toBe(child.length);

    const parentContext = adapter.getRunContext('parent');
    const childContext = adapter.getRunContext('child');
    expect(childContext).toMatchObject({
      parentRunId: 'parent',
      traceId: parentContext?.traceId,
      parentSpanId: parentContext?.spanId,
    });

    const serialized = JSON.stringify(runEvents);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('root-secret-token');
    expect(serialized).not.toContain('progress-key');
    expect(serialized).not.toContain('result-token');
    expect(serialized).not.toContain('opaque-provider-signature');
    expect(serialized).not.toContain('sk-proj-super-secret');
    expect(serialized).not.toContain('C:\\\\secret');
    expect(serialized).toContain('[REDACTED]');

    // Boundary normalization never mutates runtime-owned payloads.
    expect((fixture.sensitiveToolCall as Extract<AgentEvent, { type: 'tool.call' }>).call.input)
      .toMatchObject({ password: 'hunter2' });
    expect((fixture.signedReasoning as Extract<AgentEvent, { type: 'response.thinking.delta' }>).signature)
      .toBe('opaque-provider-signature');
  });

  it('fans one semantic projection out to TUI, GUI and Bridge with full run semantics', () => {
    const { runEvents } = adaptMixedStream();
    const projector = new SharedRunEventSurfaceProjector();
    const observed: SurfaceSemanticEvent[] = [];

    for (const event of runEvents) {
      const projection = projector.project(event);
      expect(projection.tui).toEqual(projection.semantics);
      expect(projection.cli).toEqual(projection.semantics);
      expect(projection.gui).toEqual(projection.semantics);
      expect(projection.bridge).toEqual(projection.semantics);
      expect(projection.tui).not.toBe(projection.gui);
      expect(projection.gui).not.toBe(projection.bridge);
      observed.push(...projection.semantics);
    }

    expect(new Set(observed.map(event => event.category))).toEqual(new Set([
      'run', 'request', 'model', 'text', 'reasoning', 'tool', 'compaction',
      'interruption', 'error', 'terminal', 'usage',
    ]));
    expect(observed.filter(event => event.category === 'tool').map(event => event.phase))
      .toEqual(expect.arrayContaining(['input', 'started', 'progress', 'completed']));
    expect(observed.filter(event => event.category === 'compaction').map(event => event.data.scope))
      .toEqual(expect.arrayContaining(['session', 'conversation']));
    expect(observed.filter(event => event.type === 'terminal').map(event => event.data.status))
      .toEqual(expect.arrayContaining(['completed', 'failed']));
    expect(observed.find(event => event.type === 'usage')?.data).toMatchObject({ scope: 'run' });
    expect(JSON.stringify(observed)).not.toContain('opaque-provider-signature');

    const duplicate = projector.project(runEvents[0]!);
    expect(duplicate.semantics).toEqual([]);
    expect(duplicate.cli).toEqual([]);
    expect(duplicate.tui).toEqual([]);
    expect(duplicate.gui).toEqual([]);
    expect(duplicate.bridge).toEqual([]);
  });

  it('reconstructs delta snapshots and tool input without provider-specific surface state', () => {
    const sequencer = new RunEventSequencer({
      runId: 'native', traceId: 'native-trace', spanId: 'native-span',
    });
    const projector = new RunEventSemanticProjector();
    projector.project(sequencer.next('run.started', { agentId: 'chat' }));
    projector.project(sequencer.next('model.requested', { turn: 1, model: 'native-model' }));
    const textA = projector.project(sequencer.next('model.text.delta', { delta: 'hello' }));
    const textB = projector.project(sequencer.next('model.text.delta', { delta: ' world' }));
    const thoughtA = projector.project(sequencer.next('model.reasoning.delta', {
      delta: 'check ', opaque: { signature: 'must-not-leak' },
    }));
    const thoughtB = projector.project(sequencer.next('model.reasoning.delta', { delta: 'facts' }));
    projector.project(sequencer.next('model.tool_call.delta', {
      callId: 'native-call', name: 'lookup', argumentsDelta: '{"query":"sdk"}',
    }));
    const tool = projector.project(sequencer.next('tool.started', {
      callId: 'native-call', name: 'lookup', effect: 'read-only',
    }));

    expect(textA[0]?.data.snapshot).toBe('hello');
    expect(textB[0]?.data.snapshot).toBe('hello world');
    expect(thoughtA[0]?.data.snapshot).toBe('check ');
    expect(thoughtB[0]?.data.snapshot).toBe('check facts');
    expect(JSON.stringify(thoughtA)).not.toContain('must-not-leak');
    expect(tool[0]?.data.input).toEqual({ query: 'sdk' });
  });

  it('deduplicates exact replay and rejects identity collision, sequence regression, and broken traces', () => {
    const root = new RunEventSequencer({ runId: 'root', traceId: 'trace', spanId: 'root-span' });
    const first = root.next('run.started', {});

    const collisionProjector = new RunEventSemanticProjector();
    collisionProjector.project(first);
    expect(collisionProjector.project(first)).toEqual([]);
    expect(() => collisionProjector.project({
      ...first, sequence: 2, type: 'run.completed', data: { status: 'completed' },
    })).toThrow(SurfaceEventIdentityCollisionError);

    const sequenceProjector = new RunEventSemanticProjector();
    sequenceProjector.project(first);
    expect(() => sequenceProjector.project({
      ...first, eventId: 'different-id', data: { changed: true },
    })).toThrow(SurfaceEventSequenceError);

    const traceProjector = new RunEventSemanticProjector();
    traceProjector.project(first);
    expect(() => traceProjector.project({
      schemaVersion: 1,
      eventId: 'child-id',
      sequence: 1,
      runId: 'child',
      parentRunId: 'root',
      traceId: 'wrong-trace',
      spanId: 'child-span',
      parentSpanId: 'wrong-parent-span',
      type: 'run.started',
      timestamp: '2026-07-11T00:00:00.000Z',
      data: {},
    })).toThrow(SurfaceEventTraceError);
  });

  it('maps every representable semantic back to the legacy compatibility union', () => {
    const { runEvents } = adaptMixedStream();
    const reverse = new RunEventLegacyCompatAdapter();
    const events: AgentEvent[] = [];
    const omissions: string[] = [];
    for (const event of runEvents) {
      const projected = reverse.adaptWithReport(event);
      events.push(...projected.events);
      omissions.push(...projected.omitted.map(item => item.semanticType));
    }

    const types = events.map(event => event.type);
    expect(types).toEqual(expect.arrayContaining([
      'run.started',
      'request.started',
      'response.text.delta',
      'response.thinking.delta',
      'response.tool_input.delta',
      'response.content',
      'model.fallback',
      'tool.call',
      'tool.progress',
      'tool.result',
      'conversation.compacted',
      'session.compacted',
      'request.interrupted',
      'response.completed',
      'error',
    ]));
    expect(omissions).toEqual([]);

    const reasoning = events.find(
      (event): event is Extract<AgentEvent, { type: 'response.thinking.delta' }> => (
        event.type === 'response.thinking.delta'
      ),
    );
    expect(reasoning?.signature).toBeUndefined();
    const call = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool.call' }> => event.type === 'tool.call',
    );
    expect(call?.call.input).toMatchObject({ password: '[REDACTED]' });
    const error = events.find(
      (event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(error?.error.stack).toBeUndefined();
    expect(error?.error.message).not.toContain('sk-proj-super-secret');
  });
});
