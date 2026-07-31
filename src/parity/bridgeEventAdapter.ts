/**
 * Bridge → Agent event adapter.
 *
 * Maps `HadamardBridgeJsonEvent` (the canonical system/assistant/result trio
 * that all directCli providers normalize into) to the `AgentEvent` union that
 * the GUI's `forwardAgentEvent` already switches on. This is the inverse of
 * `cleanEventToBridgeEvents` in hadamardCleanBridgeCompatSdk.ts.
 */

import type { HadamardBridgeJsonEvent, HadamardBridgeRunResult, AgentEvent, AgentRunResult } from '../types.js';

// ---------- per-event adaptation ----------

export interface BridgeEventAdapterState {
  textSnapshot: string;
}

export function createBridgeEventAdapterState(): BridgeEventAdapterState {
  return { textSnapshot: '' };
}

export function bridgeEventToAgentEvents(
  event: HadamardBridgeJsonEvent,
  _sessionId: string,
  runId: string,
  model: string,
  state: BridgeEventAdapterState = createBridgeEventAdapterState(),
): AgentEvent[] {
  const events: AgentEvent[] = [];

  if (event.type === 'system' && event.subtype === 'init') {
    events.push({
      type: 'run.started',
      runId,
      sessionId: String(event.session_id ?? ''),
      model: typeof event.model === 'string' ? event.model : model,
      timestamp: new Date().toISOString(),
      input: '',
    } as unknown as AgentEvent);
  }

  if (event.type === 'stream_event' && typeof event.event === 'object' && event.event !== null) {
    const inner = event.event as Record<string, unknown>;
    if (
      inner.type === 'content_block_delta' &&
      typeof inner.delta === 'object' &&
      inner.delta !== null &&
      (inner.delta as Record<string, unknown>).type === 'text_delta'
    ) {
      const delta = String((inner.delta as Record<string, unknown>).text ?? '');
      state.textSnapshot += delta;
      events.push({
        type: 'response.text.delta',
        runId,
        iteration: 0,
        delta,
        snapshot: state.textSnapshot,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (event.type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined;
    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            const name = String(b.name ?? 'Tool');
            events.push({
              type: 'tool.call',
              call: {
                id: String(b.id ?? ''),
                name,
                publicName: name,
                provider: 'local',
                input: (b.input ?? {}) as Record<string, unknown>,
                startedAt: new Date().toISOString(),
              },
              runId,
              iteration: 0,
              timestamp: new Date().toISOString(),
            } as unknown as AgentEvent);
          }
        }
      }
    }
  }

  if (event.type === 'user') {
    const record = event as Record<string, unknown>;
    const message = typeof record.message === 'object' && record.message !== null
      ? record.message as Record<string, unknown>
      : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const toolResults = [
      ...(record.tool_result && typeof record.tool_result === 'object'
        ? [record.tool_result as Record<string, unknown>]
        : []),
      ...content.filter((block): block is Record<string, unknown> =>
        typeof block === 'object' && block !== null
          && (block as Record<string, unknown>).type === 'tool_result'),
    ];
    for (const tr of toolResults) {
      const output = visibleBridgeToolResult(tr.content ?? tr.output);
      const timestamp = new Date().toISOString();
      events.push({
        type: 'tool.result',
        result: {
          id: String(tr.tool_use_id ?? tr.id ?? ''),
          name: String(tr.name ?? 'Tool'),
          publicName: String(tr.name ?? 'Tool'),
          provider: 'local',
          input: {},
          startedAt: timestamp,
          outputText: output,
          output: tr,
          isError: tr.is_error === true,
          completedAt: timestamp,
          durationMs: 0,
        },
        runId,
        iteration: 0,
        timestamp,
      } as unknown as AgentEvent);
    }
  }

  return events;
}

function visibleBridgeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(visibleBridgeToolResult).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object' || value === null) return value == null ? '' : String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (record.content !== undefined) return visibleBridgeToolResult(record.content);
  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

// ---------- stream wrapper ----------

export interface BridgeAgentRunStream {
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent>;
  result: Promise<AgentRunResult>;
}

/**
 * Wrap an `HadamardBridgeRunStream` into an async iterable of `AgentEvent`
 * + a `.result` promise, so the GUI run loop can branch ONLY the stream source.
 */
export function adaptBridgeRun(
  bridgeStream: AsyncIterable<HadamardBridgeJsonEvent>,
  bridgeResult: Promise<HadamardBridgeRunResult>,
  runId: string,
  model: string,
): BridgeAgentRunStream {
  let finalResult: AgentRunResult | undefined;
  const adapterState = createBridgeEventAdapterState();
  const resultPromise = bridgeResult.then(
    (r) => {
      finalResult = {
        sessionId: r.sessionId,
        text: r.text,
        model,
        runId,
        startedAt: (r.initEvent?.['timestamp'] as string) ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        requests: [],
        messages: [],
        toolCalls: [],
        message: {
          id: `bridge-${runId}`,
          role: 'assistant' as const,
          type: 'message' as const,
          model,
          stop_reason: 'end_turn' as const,
          content: [{ type: 'text' as const, text: r.text }],
        },
        stopReason: (r.stopReason as AgentRunResult['stopReason']) ?? 'end_turn',
      } as AgentRunResult;
      if (r.isError) {
        return Promise.reject(new Error(r.text || 'Bridge run failed'));
      }
      return finalResult;
    },
    (err) => Promise.reject(err),
  );

  const iterator: AsyncIterator<AgentEvent> = (async function* () {
    for await (const event of bridgeStream) {
      const agentEvents = bridgeEventToAgentEvents(
        event,
        '',
        runId,
        model,
        adapterState,
      );
      for (const ae of agentEvents) yield ae;
    }
    await resultPromise.catch(() => undefined);
  })() as AsyncIterator<AgentEvent>;

  return {
    [Symbol.asyncIterator]: () => iterator,
    result: resultPromise as Promise<AgentRunResult>,
  };
}
