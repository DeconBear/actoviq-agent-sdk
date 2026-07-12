import type { RunEvent } from '../events/runEvents.js';
import type {
  AgentEvent,
  AgentRunResult,
  AgentToolCallEventPayload,
  AgentToolCallRecord,
  ToolProgressData,
} from '../types.js';
import { asRecord, finiteNumber, safeInteger, stringValue } from './internal.js';
import {
  RunEventSemanticProjector,
  type RunEventSemanticProjectorOptions,
} from './runEventProjector.js';
import type { SurfaceSemanticEvent } from './types.js';

export interface LegacyCompatibilityProjection {
  readonly events: readonly AgentEvent[];
  readonly omitted: readonly {
    sourceEventId: string;
    semanticType: SurfaceSemanticEvent['type'];
    reason: string;
  }[];
}

/**
 * Temporary new-to-old compatibility path. It deliberately emits only legacy
 * events whose required fields can be represented; callers can inspect
 * `omitted` instead of receiving fabricated provider-specific values.
 */
export class RunEventLegacyCompatAdapter {
  readonly semanticProjector: RunEventSemanticProjector;

  constructor(options: RunEventSemanticProjectorOptions = {}) {
    this.semanticProjector = new RunEventSemanticProjector(options);
  }

  adapt(event: RunEvent): AgentEvent[] {
    return [...this.adaptWithReport(event).events];
  }

  adaptWithReport(event: RunEvent): LegacyCompatibilityProjection {
    const events: AgentEvent[] = [];
    const omitted: LegacyCompatibilityProjection['omitted'][number][] = [];
    for (const semantic of this.semanticProjector.project(event)) {
      const projected = surfaceSemanticToLegacyAgentEvent(semantic);
      if (projected) events.push(projected);
      else if (!hasNoLegacyEquivalent(semantic)) {
        omitted.push({
          sourceEventId: semantic.sourceEventId,
          semanticType: semantic.type,
          reason: 'The legacy AgentEvent contract cannot represent the available fields without fabrication.',
        });
      }
    }
    return { events, omitted };
  }

  reset(): void {
    this.semanticProjector.reset();
  }
}

export function surfaceSemanticToLegacyAgentEvent(
  semantic: SurfaceSemanticEvent,
): AgentEvent | undefined {
  const data = semantic.data;
  const iteration = safeInteger(data.iteration) ?? 0;
  switch (semantic.type) {
    case 'run.started': {
      const model = modelName(data.model);
      if (!model) return undefined;
      return {
        type: 'run.started',
        runId: semantic.runId,
        sessionId: stringValue(data.sessionId),
        model,
        input: stringValue(data.input) ?? '',
        timestamp: semantic.timestamp,
      };
    }
    case 'request.started':
      return {
        type: 'request.started',
        runId: semantic.runId,
        iteration,
        requestTokenEstimate: safeInteger(data.requestTokenEstimate),
        requestByteLength: safeInteger(data.requestByteLength),
        localMicrocompact: asRecord(data.localMicrocompact) as never,
        timestamp: semantic.timestamp,
      };
    case 'text.delta':
      return {
        type: 'response.text.delta',
        runId: semantic.runId,
        iteration,
        delta: stringValue(data.delta) ?? '',
        snapshot: stringValue(data.snapshot) ?? '',
        timestamp: semantic.timestamp,
      };
    case 'reasoning.delta':
      return {
        type: 'response.thinking.delta',
        runId: semantic.runId,
        iteration,
        index: safeInteger(data.outputIndex) ?? 0,
        delta: stringValue(data.delta) ?? '',
        snapshot: stringValue(data.snapshot) ?? '',
        // Provider signatures intentionally never cross the surface boundary.
        timestamp: semantic.timestamp,
      };
    case 'tool.input.delta':
      return {
        type: 'response.tool_input.delta',
        runId: semantic.runId,
        iteration,
        index: safeInteger(data.outputIndex) ?? 0,
        toolUseId: stringValue(data.callId),
        toolName: stringValue(data.name),
        delta: stringValue(data.delta) ?? '',
        snapshot: stringValue(data.snapshot) ?? '',
        timestamp: semantic.timestamp,
      };
    case 'model.content':
      if (data.kind === 'content' && data.content !== undefined) {
        return {
          type: 'response.content',
          runId: semantic.runId,
          iteration,
          content: data.content as never,
          timestamp: semantic.timestamp,
        };
      }
      if (data.kind === 'message' && data.message !== undefined) {
        return {
          type: 'response.message',
          runId: semantic.runId,
          iteration,
          message: data.message as never,
          timestamp: semantic.timestamp,
        };
      }
      return undefined;
    case 'tool.started': {
      const call = legacyToolCall(data);
      if (!call) return undefined;
      return {
        type: 'tool.call',
        runId: semantic.runId,
        iteration,
        call,
        timestamp: semantic.timestamp,
      };
    }
    case 'tool.permission': {
      const decision = asRecord(data.decision);
      if (!decision) return undefined;
      return {
        type: 'tool.permission',
        runId: semantic.runId,
        iteration,
        decision: decision as never,
        timestamp: semantic.timestamp,
      };
    }
    case 'tool.progress': {
      const callId = stringValue(data.callId);
      const progress = asRecord(data.progress);
      if (!callId || !progress || !stringValue(progress.type)) return undefined;
      return {
        type: 'tool.progress',
        runId: semantic.runId,
        iteration,
        toolUseId: callId,
        data: progress as ToolProgressData,
        timestamp: semantic.timestamp,
      };
    }
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.rejected': {
      const result = legacyToolResult(data, semantic.type !== 'tool.completed');
      if (!result) return undefined;
      return {
        type: 'tool.result',
        runId: semantic.runId,
        iteration,
        result,
        timestamp: semantic.timestamp,
      };
    }
    case 'compaction.completed':
      if (data.scope === 'session') {
        const sessionId = stringValue(data.sessionId);
        const trigger = stringValue(data.trigger);
        const result = asRecord(data.result);
        if (!sessionId || !trigger || !result) return undefined;
        return {
          type: 'session.compacted',
          runId: semantic.runId,
          sessionId,
          trigger: trigger as never,
          result: result as never,
          timestamp: semantic.timestamp,
        };
      }
      if (data.scope === 'conversation') {
        const before = finiteNumber(data.tokenEstimateBefore);
        const after = finiteNumber(data.tokenEstimateAfter);
        const summarized = safeInteger(data.messagesSummarized);
        const preserved = safeInteger(data.preservedMessages);
        const cleared = safeInteger(data.clearedToolResults);
        if (before === undefined || after === undefined || summarized === undefined
          || preserved === undefined || cleared === undefined) return undefined;
        return {
          type: 'conversation.compacted',
          runId: semantic.runId,
          iteration,
          trigger: stringValue(data.trigger) as 'auto' | 'reactive' | undefined,
          tokenEstimateBefore: before,
          tokenEstimateAfter: after,
          messagesSummarized: summarized,
          preservedMessages: preserved,
          clearedToolResults: cleared,
          timestamp: semantic.timestamp,
        };
      }
      return undefined;
    case 'model.fallback': {
      const fromModel = stringValue(data.fromModel);
      const toModel = stringValue(data.toModel);
      const reason = stringValue(data.reason);
      if (!fromModel || !toModel || !reason) return undefined;
      return {
        type: 'model.fallback',
        runId: semantic.runId,
        iteration,
        fromModel,
        toModel,
        reason,
        timestamp: semantic.timestamp,
      };
    }
    case 'interruption.requested': {
      if (data.scope !== 'request') return undefined;
      const retry = safeInteger(data.retry);
      const maxRetries = safeInteger(data.maxRetries);
      const reason = stringValue(data.reason);
      if (retry === undefined || maxRetries === undefined || !reason) return undefined;
      return {
        type: 'request.interrupted',
        runId: semantic.runId,
        iteration,
        retry,
        maxRetries,
        reason,
        timestamp: semantic.timestamp,
      };
    }
    case 'error': {
      const message = stringValue(data.message);
      if (!message) return undefined;
      return {
        type: 'error',
        runId: semantic.runId,
        error: {
          message,
          code: stringValue(data.code),
          // Stack is deliberately not represented at the product boundary.
        },
        timestamp: semantic.timestamp,
      };
    }
    case 'terminal': {
      if (data.status !== 'completed') return undefined;
      const result = asRecord(data.result);
      if (!isLegacyRunResult(result)) return undefined;
      return {
        type: 'response.completed',
        runId: semantic.runId,
        result: result as unknown as AgentRunResult,
        timestamp: semantic.timestamp,
      };
    }
    default:
      return undefined;
  }
}

function legacyToolCall(data: Readonly<Record<string, unknown>>): AgentToolCallEventPayload | undefined {
  const exact = asRecord(data.call);
  const source = exact ?? data;
  const id = stringValue(source.id) ?? stringValue(data.callId);
  const name = stringValue(source.name) ?? stringValue(data.name);
  const publicName = stringValue(source.publicName) ?? stringValue(data.publicName);
  const provider = source.provider ?? data.provider;
  const startedAt = stringValue(source.startedAt) ?? stringValue(data.startedAt);
  if (!id || !name || !publicName || (provider !== 'local' && provider !== 'mcp') || !startedAt) {
    return undefined;
  }
  return {
    id,
    name,
    publicName,
    provider,
    mcpServerName: stringValue(source.mcpServerName) ?? stringValue(data.mcpServerName),
    input: source.input ?? data.input,
    startedAt,
  };
}

function legacyToolResult(
  data: Readonly<Record<string, unknown>>,
  failed: boolean,
): AgentToolCallRecord | undefined {
  const exact = asRecord(data.result);
  const call = legacyToolCall(exact ? { ...data, call: exact } : data);
  if (!call) return undefined;
  const source = exact ?? data;
  const completedAt = stringValue(source.completedAt) ?? stringValue(data.completedAt);
  const durationMs = finiteNumber(source.durationMs) ?? finiteNumber(data.durationMs);
  const outputText = stringValue(source.outputText) ?? stringValue(data.outputText);
  if (!completedAt || durationMs === undefined || outputText === undefined) return undefined;
  return {
    ...call,
    outputText,
    output: source.output ?? data.output,
    isError: source.isError === true || failed,
    completedAt,
    durationMs,
  };
}

function modelName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return stringValue(asRecord(value)?.model);
}

function isLegacyRunResult(value: Record<string, unknown> | undefined): boolean {
  return Boolean(
    value
      && stringValue(value.runId)
      && stringValue(value.model)
      && typeof value.text === 'string'
      && asRecord(value.message)
      && Array.isArray(value.messages)
      && Array.isArray(value.requests)
      && Array.isArray(value.toolCalls)
      && stringValue(value.startedAt)
      && stringValue(value.completedAt),
  );
}

function hasNoLegacyEquivalent(semantic: SurfaceSemanticEvent): boolean {
  return semantic.type === 'usage'
    || semantic.type === 'model.completed'
    || semantic.type === 'request.completed'
    || semantic.type === 'run.resumed'
    || (semantic.type === 'terminal' && semantic.data.status !== 'completed')
    || semantic.type === 'extension';
}
