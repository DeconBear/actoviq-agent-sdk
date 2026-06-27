/**
 * Bridge → Agent event adapter.
 *
 * Maps `ActoviqBridgeJsonEvent` (the canonical system/assistant/result trio
 * that all directCli providers normalize into) to the `AgentEvent` union that
 * the GUI's `forwardAgentEvent` already switches on. This is the inverse of
 * `cleanEventToBridgeEvents` in actoviqCleanBridgeCompatSdk.ts.
 */

import type { ActoviqBridgeJsonEvent, ActoviqBridgeRunResult, AgentEvent, AgentRunResult } from '../types.js';

// ---------- per-event adaptation ----------

export function bridgeEventToAgentEvents(
  event: ActoviqBridgeJsonEvent,
  _sessionId: string,
  runId: string,
  model: string,
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
      events.push({
        type: 'response.text.delta',
        delta: String((inner.delta as Record<string, unknown>).text ?? ''),
        snapshot: String((inner.delta as Record<string, unknown>).text ?? ''),
        timestamp: new Date().toISOString(),
      } as unknown as AgentEvent);
    }
  }

  if (event.type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined;
    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            events.push({
              type: 'tool.call',
              call: {
                id: String(b.id ?? ''),
                name: String(b.name ?? ''),
                input: (b.input ?? {}) as Record<string, unknown>,
              },
              publicName: String(b.name ?? ''),
              provider: 'bridge',
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
    const tr = (event as Record<string, unknown>).tool_result;
    if (tr && typeof tr === 'object') {
      events.push({
        type: 'tool.result',
        result: {
          id: String((tr as Record<string, unknown>).tool_use_id ?? ''),
          output: tr,
        },
        timestamp: new Date().toISOString(),
      } as unknown as AgentEvent);
    }
  }

  return events;
}

// ---------- stream wrapper ----------

export interface BridgeAgentRunStream {
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent>;
  result: Promise<AgentRunResult>;
}

/**
 * Wrap an `ActoviqBridgeRunStream` into an async iterable of `AgentEvent`
 * + a `.result` promise, so the GUI run loop can branch ONLY the stream source.
 */
export function adaptBridgeRun(
  bridgeStream: AsyncIterable<ActoviqBridgeJsonEvent>,
  bridgeResult: Promise<ActoviqBridgeRunResult>,
  runId: string,
  model: string,
): BridgeAgentRunStream {
  let finalResult: AgentRunResult | undefined;
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
