import type { RunEvent, RunEventContext, TraceContext } from '../events/runEvents.js';
import {
  RunEventSequencer,
  createChildTraceContext,
  createRootTraceContext,
} from '../events/runEvents.js';
import type { AgentEvent } from '../types.js';
import { IdentityWindow, asRecord, stableFingerprint, stringValue } from './internal.js';
import { redactSurfaceValue, type SurfaceRedactionOptions } from './redaction.js';

export interface LegacyRunContextRegistration extends RunEventContext {}

export interface LegacyAgentEventAdapterOptions {
  readonly runContexts?: readonly LegacyRunContextRegistration[];
  readonly dedupeWindowSize?: number;
  readonly identityKey?: (event: AgentEvent) => string | undefined;
  readonly redaction?: SurfaceRedactionOptions;
}

interface LegacyRunState {
  readonly sequencer: RunEventSequencer;
}

interface NormalizedLegacyEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * Stateful migration adapter from the unversioned AgentEvent union to the
 * versioned RunEvent envelope. Sequence counters are isolated per run, so an
 * interleaved parent/child stream remains monotonic without imposing a global
 * order. Byte-equivalent transport replays are suppressed within a bounded
 * identity window.
 */
export class LegacyAgentEventRunEventAdapter {
  private readonly states = new Map<string, LegacyRunState>();
  private readonly registrations = new Map<string, RunEventContext>();
  private readonly identities: IdentityWindow;
  private readonly identityKey?: LegacyAgentEventAdapterOptions['identityKey'];
  private readonly redaction: SurfaceRedactionOptions;

  constructor(options: LegacyAgentEventAdapterOptions = {}) {
    this.identities = new IdentityWindow(options.dedupeWindowSize ?? 8_192);
    this.identityKey = options.identityKey;
    this.redaction = options.redaction ?? {};
    for (const context of options.runContexts ?? []) this.registerRun(context);
  }

  /** Registers an externally-created trace context before the run emits. */
  registerRun(context: LegacyRunContextRegistration): RunEventContext {
    assertRunContext(context);
    const cloned = { ...context };
    const existing = this.states.get(context.runId)?.sequencer.context
      ?? this.registrations.get(context.runId);
    if (existing && !sameRunContext(existing, cloned)) {
      throw new Error(`Run context for "${context.runId}" cannot change after registration.`);
    }
    if (cloned.parentRunId) {
      const parent = this.states.get(cloned.parentRunId)?.sequencer.context
        ?? this.registrations.get(cloned.parentRunId);
      if (parent) assertParentContext(cloned, parent);
    }
    for (const child of this.registrations.values()) {
      if (child.parentRunId === cloned.runId) assertParentContext(child, cloned);
    }
    this.registrations.set(context.runId, cloned);
    return { ...cloned };
  }

  registerRootRun(runId: string, trace?: Partial<TraceContext>): RunEventContext {
    const generated = createRootTraceContext(runId);
    return this.registerRun({
      runId,
      traceId: trace?.traceId ?? generated.traceId,
      spanId: trace?.spanId ?? generated.spanId,
      parentRunId: undefined,
      parentSpanId: undefined,
    });
  }

  registerChildRun(
    runId: string,
    parentRunId: string,
    trace?: Partial<TraceContext>,
  ): RunEventContext {
    const parent = this.ensureRun(parentRunId).sequencer.context;
    const generated = createChildTraceContext(runId, parentRunId, parent);
    return this.registerRun({
      ...generated,
      traceId: trace?.traceId ?? generated.traceId,
      spanId: trace?.spanId ?? generated.spanId,
      parentSpanId: trace?.parentSpanId ?? generated.parentSpanId,
      runId,
      parentRunId,
    });
  }

  adapt(event: AgentEvent): RunEvent | undefined {
    const raw = event as AgentEvent & Record<string, unknown>;
    const runId = event.runId;
    const state = this.ensureRunFromEvent(runId, raw);
    const fingerprint = stableFingerprint(event);
    const embeddedEventId = stringValue(raw.eventId);
    const identity = this.identityKey?.(event) ?? embeddedEventId ?? fingerprint;
    const identityKey = embeddedEventId
      ? `event:${embeddedEventId}`
      : `legacy:${runId}:${identity}`;
    const identityStatus = this.identities.inspect(identityKey, fingerprint);
    if (identityStatus === 'duplicate') return undefined;
    if (identityStatus === 'collision') {
      throw new Error(`Legacy event identity collision for run "${runId}" and key "${identity}".`);
    }

    const normalized = normalizeLegacyEvent(event);
    const redacted = redactSurfaceValue(normalized.data, this.redaction);
    const data = asRecord(redacted) ?? {};
    const next = state.sequencer.next(normalized.type, data, event.timestamp);
    this.identities.remember(identityKey, fingerprint);
    return embeddedEventId ? { ...next, eventId: embeddedEventId } : next;
  }

  adaptMany(events: Iterable<AgentEvent>): RunEvent[] {
    const output: RunEvent[] = [];
    for (const event of events) {
      const adapted = this.adapt(event);
      if (adapted) output.push(adapted);
    }
    return output;
  }

  getRunContext(runId: string): RunEventContext | undefined {
    const context = this.states.get(runId)?.sequencer.context ?? this.registrations.get(runId);
    return context ? { ...context } : undefined;
  }

  getLastSequence(runId: string): number {
    return this.states.get(runId)?.sequencer.lastSequence ?? 0;
  }

  reset(): void {
    this.states.clear();
    this.registrations.clear();
    this.identities.clear();
  }

  private ensureRunFromEvent(
    runId: string,
    event: Record<string, unknown>,
  ): LegacyRunState {
    const existing = this.states.get(runId);
    if (existing) return existing;
    if (!this.registrations.has(runId)) {
      const parentRunId = stringValue(event.parentRunId);
      const traceId = stringValue(event.traceId);
      const spanId = stringValue(event.spanId);
      if (traceId && spanId) {
        this.registerRun({
          runId,
          parentRunId,
          traceId,
          spanId,
          parentSpanId: stringValue(event.parentSpanId),
        });
      } else if (parentRunId) {
        this.registerChildRun(runId, parentRunId);
      }
    }
    return this.ensureRun(runId);
  }

  private ensureRun(runId: string): LegacyRunState {
    const existing = this.states.get(runId);
    if (existing) return existing;
    const context = this.registrations.get(runId) ?? createRootTraceContext(runId);
    const state = { sequencer: new RunEventSequencer({ ...context }) };
    this.states.set(runId, state);
    return state;
  }
}

function normalizeLegacyEvent(event: AgentEvent): NormalizedLegacyEvent {
  switch (event.type) {
    case 'run.started':
      return {
        type: 'run.started',
        data: {
          sessionId: event.sessionId,
          model: event.model,
          input: event.input,
        },
      };
    case 'request.started':
      return {
        type: 'model.requested',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          requestTokenEstimate: event.requestTokenEstimate,
          requestByteLength: event.requestByteLength,
          localMicrocompact: event.localMicrocompact,
        },
      };
    case 'response.text.delta':
      return {
        type: 'model.text.delta',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          delta: event.delta,
          snapshot: event.snapshot,
        },
      };
    case 'response.thinking.delta':
      return {
        type: 'model.reasoning.delta',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          outputIndex: event.index,
          index: event.index,
          delta: event.delta,
          snapshot: event.snapshot,
          // The provider signature is intentionally omitted at the surface boundary.
        },
      };
    case 'response.tool_input.delta':
      return {
        type: 'model.tool_call.delta',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          outputIndex: event.index,
          index: event.index,
          callId: event.toolUseId,
          toolUseId: event.toolUseId,
          name: event.toolName,
          argumentsDelta: event.delta,
          delta: event.delta,
          snapshot: event.snapshot,
        },
      };
    case 'response.content':
      return {
        type: 'model.content',
        data: { turn: event.iteration, iteration: event.iteration, kind: 'content', content: event.content },
      };
    case 'response.message':
      return {
        type: 'model.content',
        data: { turn: event.iteration, iteration: event.iteration, kind: 'message', message: event.message },
      };
    case 'tool.call':
      return {
        type: 'tool.started',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          callId: event.call.id,
          name: event.call.name,
          publicName: event.call.publicName,
          provider: event.call.provider,
          mcpServerName: event.call.mcpServerName,
          input: event.call.input,
          startedAt: event.call.startedAt,
          call: event.call,
        },
      };
    case 'tool.permission':
      return {
        type: 'tool.permission',
        data: { turn: event.iteration, iteration: event.iteration, decision: event.decision },
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          callId: event.toolUseId,
          toolUseId: event.toolUseId,
          progress: event.data,
          data: event.data,
        },
      };
    case 'tool.result':
      return {
        type: event.result.isError ? 'tool.failed' : 'tool.completed',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          callId: event.result.id,
          name: event.result.name,
          publicName: event.result.publicName,
          provider: event.result.provider,
          mcpServerName: event.result.mcpServerName,
          input: event.result.input,
          output: event.result.output,
          outputText: event.result.outputText,
          isError: event.result.isError,
          startedAt: event.result.startedAt,
          completedAt: event.result.completedAt,
          durationMs: event.result.durationMs,
          result: event.result,
        },
      };
    case 'session.compacted':
      return {
        type: 'session.compacted',
        data: {
          scope: 'session',
          sessionId: event.sessionId,
          trigger: event.trigger,
          result: event.result,
        },
      };
    case 'conversation.compacted':
      return {
        type: 'conversation.compacted',
        data: {
          scope: 'conversation',
          turn: event.iteration,
          iteration: event.iteration,
          trigger: event.trigger,
          tokenEstimateBefore: event.tokenEstimateBefore,
          tokenEstimateAfter: event.tokenEstimateAfter,
          messagesSummarized: event.messagesSummarized,
          preservedMessages: event.preservedMessages,
          clearedToolResults: event.clearedToolResults,
        },
      };
    case 'model.fallback':
      return {
        type: 'model.fallback',
        data: {
          turn: event.iteration,
          iteration: event.iteration,
          fromModel: event.fromModel,
          toModel: event.toModel,
          reason: event.reason,
        },
      };
    case 'request.interrupted':
      return {
        type: 'model.interrupted',
        data: {
          scope: 'request',
          turn: event.iteration,
          iteration: event.iteration,
          retry: event.retry,
          maxRetries: event.maxRetries,
          reason: event.reason,
        },
      };
    case 'response.completed':
      return {
        type: 'run.completed',
        data: {
          status: 'completed',
          result: event.result,
          usage: event.result.usage,
        },
      };
    case 'error':
      return { type: 'run.failed', data: { status: 'failed', error: event.error } };
    default:
      return {
        type: `legacy.${event.type}`,
        data: stripLegacyEnvelope(event as AgentEvent & Record<string, unknown>),
      };
  }
}

function stripLegacyEnvelope(event: Record<string, unknown>): Record<string, unknown> {
  const output = { ...event };
  delete output.type;
  delete output.runId;
  delete output.timestamp;
  delete output.eventId;
  delete output.sequence;
  delete output.schemaVersion;
  delete output.traceId;
  delete output.spanId;
  delete output.parentSpanId;
  delete output.parentRunId;
  return output;
}

function assertRunContext(context: RunEventContext): void {
  if (!context.runId.trim()) throw new Error('runId must not be empty.');
  if (!context.traceId.trim()) throw new Error('traceId must not be empty.');
  if (!context.spanId.trim()) throw new Error('spanId must not be empty.');
  if (context.parentRunId && !context.parentSpanId) {
    throw new Error('A child run context must include parentSpanId.');
  }
}

function sameRunContext(left: RunEventContext, right: RunEventContext): boolean {
  return left.runId === right.runId
    && left.parentRunId === right.parentRunId
    && left.traceId === right.traceId
    && left.spanId === right.spanId
    && left.parentSpanId === right.parentSpanId;
}

function assertParentContext(child: RunEventContext, parent: RunEventContext): void {
  if (child.traceId !== parent.traceId || child.parentSpanId !== parent.spanId) {
    throw new Error(
      `Run "${child.runId}" does not inherit trace/span context from "${parent.runId}".`,
    );
  }
}
