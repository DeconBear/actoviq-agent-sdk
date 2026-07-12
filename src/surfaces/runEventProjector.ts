import type { RunEvent, RunEventContext } from '../events/runEvents.js';
import { IdentityWindow, asRecord, finiteNumber, safeInteger, stableFingerprint, stringValue } from './internal.js';
import { redactSurfaceValue, type SurfaceRedactionOptions } from './redaction.js';
import type {
  SharedSurfaceProjection,
  SurfaceSemanticCategory,
  SurfaceSemanticEvent,
  SurfaceSemanticType,
} from './types.js';

export interface RunEventSemanticProjectorOptions {
  readonly dedupeWindowSize?: number;
  readonly redaction?: SurfaceRedactionOptions;
  /** Unknown producer event types are preserved as redacted extension events. */
  readonly includeExtensions?: boolean;
}

interface ProjectionRunState {
  lastSequence: number;
  readonly context: RunEventContext;
  currentIteration: number;
  readonly textSnapshots: Map<string, string>;
  readonly reasoningSnapshots: Map<string, string>;
  readonly toolInputSnapshots: Map<string, string>;
  readonly tools: Map<string, Record<string, unknown>>;
}

export class SurfaceEventSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceEventSequenceError';
  }
}

export class SurfaceEventTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceEventTraceError';
  }
}

export class SurfaceEventIdentityCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceEventIdentityCollisionError';
  }
}

/**
 * Validates and normalizes RunEvents into one semantic vocabulary shared by
 * every product surface. It is stateful because provider deltas do not always
 * carry snapshots and because mixed parent/child streams must be validated per
 * run rather than against one global counter.
 */
export class RunEventSemanticProjector {
  private readonly runs = new Map<string, ProjectionRunState>();
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly identities: IdentityWindow;
  private readonly redaction: SurfaceRedactionOptions;
  private readonly includeExtensions: boolean;

  constructor(options: RunEventSemanticProjectorOptions = {}) {
    this.identities = new IdentityWindow(options.dedupeWindowSize ?? 8_192);
    this.redaction = options.redaction ?? {};
    this.includeExtensions = options.includeExtensions ?? true;
  }

  project(event: RunEvent): SurfaceSemanticEvent[] {
    assertRunEventEnvelope(event);
    const fingerprint = stableFingerprint(event);
    const identityStatus = this.identities.inspect(event.eventId, fingerprint);
    if (identityStatus === 'duplicate') return [];
    if (identityStatus === 'collision') {
      throw new SurfaceEventIdentityCollisionError(
        `RunEvent eventId "${event.eventId}" was reused with different content.`,
      );
    }

    const state = this.validateAndAdvance(event);
    this.identities.remember(event.eventId, fingerprint);
    const redacted = redactSurfaceValue(event.data, this.redaction);
    const data = asRecord(redacted) ?? { value: redacted };
    const output: SurfaceSemanticEvent[] = [];
    const push = (
      type: SurfaceSemanticType,
      category: SurfaceSemanticCategory,
      phase: string,
      semanticData: Record<string, unknown>,
    ) => {
      const projectionIndex = output.length;
      output.push({
        semanticVersion: 1,
        semanticId: `${event.eventId}:${projectionIndex}`,
        sourceEventId: event.eventId,
        sourceType: event.type,
        projectionIndex,
        sequence: event.sequence,
        runId: event.runId,
        parentRunId: event.parentRunId,
        traceId: event.traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        timestamp: event.timestamp,
        type,
        category,
        phase,
        data: semanticData,
      });
    };

    switch (event.type) {
      case 'run.started':
        push('run.started', 'run', 'started', data);
        break;
      case 'run.resumed':
        push('run.resumed', 'run', 'resumed', data);
        break;
      case 'model.requested':
      case 'request.started': {
        const iteration = resolveIteration(data, state.currentIteration + 1);
        state.currentIteration = iteration;
        push('request.started', 'request', 'started', { ...data, iteration });
        break;
      }
      case 'model.text.delta':
      case 'response.text.delta': {
        const delta = stringValue(data.delta) ?? '';
        const key = blockKey(data);
        const snapshot = updateSnapshot(state.textSnapshots, key, delta, stringValue(data.snapshot));
        push('text.delta', 'text', 'delta', {
          delta,
          snapshot,
          outputIndex: safeInteger(data.outputIndex) ?? safeInteger(data.index),
          iteration: resolveIteration(data, state.currentIteration),
        });
        break;
      }
      case 'model.reasoning.delta':
      case 'response.thinking.delta': {
        const delta = stringValue(data.delta) ?? '';
        const key = blockKey(data);
        const snapshot = updateSnapshot(state.reasoningSnapshots, key, delta, stringValue(data.snapshot));
        // Do not forward provider reasoning signatures/opaque blobs to a UI or bridge.
        push('reasoning.delta', 'reasoning', 'delta', {
          delta,
          snapshot,
          outputIndex: safeInteger(data.outputIndex) ?? safeInteger(data.index),
          iteration: resolveIteration(data, state.currentIteration),
        });
        break;
      }
      case 'model.tool_call.delta':
      case 'response.tool_input.delta': {
        const callId = stringValue(data.callId) ?? stringValue(data.toolUseId);
        const key = callId ?? blockKey(data);
        const delta = stringValue(data.argumentsDelta) ?? stringValue(data.delta) ?? '';
        const snapshot = updateSnapshot(
          state.toolInputSnapshots,
          key,
          delta,
          stringValue(data.snapshot),
        );
        push('tool.input.delta', 'tool', 'input', {
          callId,
          name: stringValue(data.name) ?? stringValue(data.toolName),
          delta,
          snapshot,
          outputIndex: safeInteger(data.outputIndex) ?? safeInteger(data.index),
          iteration: resolveIteration(data, state.currentIteration),
        });
        break;
      }
      case 'model.content':
      case 'model.response':
      case 'response.content':
      case 'response.message':
        push('model.content', 'model', stringValue(data.kind) ?? 'content', data);
        break;
      case 'model.response.completed':
        push('request.completed', 'request', 'completed', data);
        break;
      case 'model.completed':
        push('model.completed', 'model', 'completed', {
          ...data,
          iteration: resolveIteration(data, state.currentIteration),
        });
        appendUsage(push, data, 'request');
        break;
      case 'model.fallback':
        push('model.fallback', 'model', 'fallback', data);
        break;
      case 'model.usage':
        appendUsage(push, data, 'request', true);
        break;
      case 'tool.started':
      case 'tool.call': {
        const callId = stringValue(data.callId) ?? stringValue(data.toolUseId)
          ?? stringValue(asRecord(data.call)?.id);
        const call = asRecord(data.call);
        const name = stringValue(data.name) ?? stringValue(call?.name);
        const bufferedInput = callId ? parseJsonObject(state.toolInputSnapshots.get(callId)) : undefined;
        const normalized = {
          ...data,
          callId,
          name,
          publicName: stringValue(data.publicName) ?? stringValue(call?.publicName) ?? name,
          provider: stringValue(data.provider) ?? stringValue(call?.provider),
          input: data.input ?? call?.input ?? bufferedInput,
          startedAt: stringValue(data.startedAt) ?? stringValue(call?.startedAt) ?? event.timestamp,
          iteration: resolveIteration(data, state.currentIteration),
        };
        if (callId) state.tools.set(callId, normalized);
        push('tool.started', 'tool', 'started', normalized);
        break;
      }
      case 'tool.permission':
        push('tool.permission', 'tool', 'permission', data);
        break;
      case 'tool.progress': {
        const callId = stringValue(data.callId) ?? stringValue(data.toolUseId);
        const progress = asRecord(data.progress) ?? asRecord(data.data) ?? data;
        push('tool.progress', 'tool', 'progress', {
          ...data,
          callId,
          progress,
          message: stringValue(progress.message),
          iteration: resolveIteration(data, state.currentIteration),
        });
        break;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.rejected': {
        const callId = stringValue(data.callId) ?? stringValue(data.toolUseId)
          ?? stringValue(asRecord(data.result)?.id);
        const started = callId ? state.tools.get(callId) : undefined;
        const result = asRecord(data.result);
        const failed = event.type !== 'tool.completed'
          || data.isError === true
          || result?.isError === true;
        const normalized = {
          ...started,
          ...data,
          callId,
          name: stringValue(data.name) ?? stringValue(result?.name) ?? stringValue(started?.name),
          output: data.output ?? result?.output,
          outputText: stringValue(data.outputText) ?? stringValue(result?.outputText),
          isError: failed,
          completedAt: stringValue(data.completedAt) ?? stringValue(result?.completedAt) ?? event.timestamp,
          durationMs: finiteNumber(data.durationMs) ?? finiteNumber(result?.durationMs),
          iteration: resolveIteration(data, state.currentIteration),
        };
        push(
          event.type === 'tool.rejected' ? 'tool.rejected' : failed ? 'tool.failed' : 'tool.completed',
          'tool',
          event.type === 'tool.rejected' ? 'rejected' : failed ? 'failed' : 'completed',
          normalized,
        );
        break;
      }
      case 'session.compacted':
      case 'conversation.compacted':
        push('compaction.completed', 'compaction', 'completed', {
          ...data,
          scope: stringValue(data.scope)
            ?? (event.type === 'session.compacted' ? 'session' : 'conversation'),
        });
        break;
      case 'model.interrupted':
      case 'request.interrupted':
        push('interruption.requested', 'interruption', 'request', {
          ...data,
          scope: 'request',
          iteration: resolveIteration(data, state.currentIteration),
        });
        break;
      case 'run.interrupted':
        push('interruption.requested', 'interruption', 'run', { ...data, scope: 'run' });
        push('terminal', 'terminal', 'interrupted', { ...data, status: 'interrupted' });
        break;
      case 'run.cancelled':
        push('interruption.cancelled', 'interruption', 'run', { ...data, scope: 'run' });
        push('terminal', 'terminal', 'cancelled', { ...data, status: 'cancelled' });
        break;
      case 'run.failed':
      case 'error': {
        const error = surfaceError(data.error ?? data);
        push('error', 'error', 'failed', error);
        push('terminal', 'terminal', 'failed', { status: 'failed', error });
        break;
      }
      case 'run.completed':
      case 'response.completed':
        push('terminal', 'terminal', stringValue(data.status) ?? 'completed', {
          ...data,
          status: stringValue(data.status) ?? 'completed',
        });
        appendUsage(push, data, 'run');
        break;
      default:
        if (this.includeExtensions) {
          push('extension', 'extension', 'event', { producerType: event.type, ...data });
        }
        break;
    }
    return output;
  }

  reset(): void {
    this.runs.clear();
    this.childrenByParent.clear();
    this.identities.clear();
  }

  private validateAndAdvance(event: RunEvent): ProjectionRunState {
    const existing = this.runs.get(event.runId);
    if (existing) {
      assertSameTrace(existing.context, event);
      if (event.sequence <= existing.lastSequence) {
        throw new SurfaceEventSequenceError(
          `Run "${event.runId}" sequence ${event.sequence} is not greater than ${existing.lastSequence}.`,
        );
      }
      existing.lastSequence = event.sequence;
      return existing;
    }

    const context: RunEventContext = {
      runId: event.runId,
      parentRunId: event.parentRunId,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
    };
    if (context.parentRunId && !context.parentSpanId) {
      throw new SurfaceEventTraceError(
        `Child run "${context.runId}" is missing parentSpanId.`,
      );
    }
    const parent = context.parentRunId ? this.runs.get(context.parentRunId) : undefined;
    if (parent) assertParentTrace(context, parent.context);
    const state: ProjectionRunState = {
      lastSequence: event.sequence,
      context,
      currentIteration: 0,
      textSnapshots: new Map(),
      reasoningSnapshots: new Map(),
      toolInputSnapshots: new Map(),
      tools: new Map(),
    };
    for (const childId of this.childrenByParent.get(context.runId) ?? []) {
      const child = this.runs.get(childId);
      if (child) assertParentTrace(child.context, context);
    }
    this.runs.set(event.runId, state);
    if (context.parentRunId) {
      const children = this.childrenByParent.get(context.parentRunId) ?? new Set<string>();
      children.add(context.runId);
      this.childrenByParent.set(context.parentRunId, children);
    }
    return state;
  }
}

/** Uses one state machine, then gives independent copies to all three surfaces. */
export class SharedRunEventSurfaceProjector {
  readonly semanticProjector: RunEventSemanticProjector;

  constructor(options: RunEventSemanticProjectorOptions = {}) {
    this.semanticProjector = new RunEventSemanticProjector(options);
  }

  project(event: RunEvent): SharedSurfaceProjection {
    return fanOutSurfaceSemantics(this.semanticProjector.project(event));
  }

  reset(): void {
    this.semanticProjector.reset();
  }
}

export function fanOutSurfaceSemantics(
  semantics: readonly SurfaceSemanticEvent[],
): SharedSurfaceProjection {
  const canonical = structuredClone(semantics);
  return {
    semantics: canonical,
    cli: structuredClone(canonical),
    tui: structuredClone(canonical),
    gui: structuredClone(canonical),
    bridge: structuredClone(canonical),
  };
}

type SemanticPush = (
  type: SurfaceSemanticType,
  category: SurfaceSemanticCategory,
  phase: string,
  data: Record<string, unknown>,
) => void;

function appendUsage(
  push: SemanticPush,
  data: Record<string, unknown>,
  scope: 'request' | 'run',
  dataIsUsageEnvelope = false,
): void {
  const usage = asRecord(dataIsUsageEnvelope ? data.usage ?? data : data.usage);
  if (!usage) return;
  push('usage', 'usage', 'reported', { scope, usage });
}

function resolveIteration(data: Record<string, unknown>, fallback: number): number {
  return safeInteger(data.iteration) ?? safeInteger(data.turn) ?? fallback;
}

function blockKey(data: Record<string, unknown>): string {
  return String(safeInteger(data.outputIndex) ?? safeInteger(data.index) ?? 0);
}

function updateSnapshot(
  snapshots: Map<string, string>,
  key: string,
  delta: string,
  supplied: string | undefined,
): string {
  const snapshot = supplied ?? `${snapshots.get(key) ?? ''}${delta}`;
  snapshots.set(key, snapshot);
  return snapshot;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function surfaceError(value: unknown): Record<string, unknown> {
  const error = asRecord(value);
  if (!error) return { message: typeof value === 'string' ? value : 'Unknown error' };
  return {
    message: stringValue(error.message) ?? 'Unknown error',
    ...(stringValue(error.code) ? { code: stringValue(error.code) } : {}),
    ...(stringValue(error.name) ? { name: stringValue(error.name) } : {}),
  };
}

function assertRunEventEnvelope(event: RunEvent): void {
  if (event.schemaVersion !== 1) throw new Error(`Unsupported RunEvent schemaVersion ${String(event.schemaVersion)}.`);
  if (!event.eventId?.trim()) throw new Error('RunEvent eventId must not be empty.');
  if (!event.runId?.trim()) throw new Error('RunEvent runId must not be empty.');
  if (!event.type?.trim()) throw new Error('RunEvent type must not be empty.');
  if (!event.traceId?.trim() || !event.spanId?.trim()) {
    throw new SurfaceEventTraceError('RunEvent traceId and spanId must not be empty.');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new SurfaceEventSequenceError('RunEvent sequence must be a positive safe integer.');
  }
}

function assertSameTrace(context: RunEventContext, event: RunEvent): void {
  if (
    context.parentRunId !== event.parentRunId
    || context.traceId !== event.traceId
    || context.spanId !== event.spanId
    || context.parentSpanId !== event.parentSpanId
  ) {
    throw new SurfaceEventTraceError(`Trace context changed within run "${event.runId}".`);
  }
}

function assertParentTrace(child: RunEventContext, parent: RunEventContext): void {
  if (child.parentRunId !== parent.runId) {
    throw new SurfaceEventTraceError(`Run "${child.runId}" references the wrong parent run.`);
  }
  if (child.traceId !== parent.traceId || child.parentSpanId !== parent.spanId) {
    throw new SurfaceEventTraceError(
      `Run "${child.runId}" does not inherit trace/span context from "${parent.runId}".`,
    );
  }
}
