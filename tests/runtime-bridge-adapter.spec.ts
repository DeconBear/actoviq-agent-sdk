import { describe, expect, it, vi } from 'vitest';

import type { AgentSpec, ModelRef, Usage } from '../src/core/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  mergeModelCapabilities,
  type ModelCallContext,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStream,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import { AgentRuntime, RuntimeServices } from '../src/runtime-v2/index.js';
import { AgentRuntimeBridgeAdapter } from '../src/surfaces/index.js';

const MODEL: ResolvedModel = {
  providerId: 'bridge-test',
  modelId: 'model',
  ref: { provider: 'bridge-test', model: 'model' },
};

describe('AgentRuntimeBridgeAdapter', () => {
  it('projects an existing runtime stream without creating or owning another runtime', async () => {
    const closeService = vi.fn();
    const services = new RuntimeServices({
      owned: { factory: () => ({ close: closeService }) },
    });
    await services.resolve('owned');
    const runtime = new AgentRuntime({
      models: new ModelRegistry([new BridgeTestProvider()]),
      services,
      defaultModel: 'bridge-test:model',
    });
    const agent: AgentSpec = {
      id: 'bridge-agent',
      name: 'Bridge agent',
      instructions: 'Answer briefly.',
    };
    const bridge = new AgentRuntimeBridgeAdapter({ runtime, agent });

    const handle = bridge.stream('hello', { metadata: { channel: 'bridge' } });
    const events = [];
    for await (const event of handle) events.push(event);
    const result = await handle.result;

    expect(bridge.runtime).toBe(runtime);
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.started',
      'request.started',
      'text.delta',
      'request.completed',
      'model.completed',
      'terminal',
      'usage',
    ]));
    expect(events.every(event => event.runId === handle.runId)).toBe(true);
    expect(events.every(event => Boolean(event.traceId && event.spanId))).toBe(true);
    expect(events.filter(event => event.type === 'text.delta').at(-1)?.data.snapshot)
      .toBe('bridge ok');
    expect(result.output).toBe('bridge ok');
    expect(closeService).not.toHaveBeenCalled();

    const direct = await bridge.run('again');
    expect(direct.output).toBe('bridge ok');
    expect(closeService).not.toHaveBeenCalled();

    await runtime.close();
    expect(closeService).toHaveBeenCalledOnce();
  });
});

class BridgeTestProvider implements ModelProvider {
  readonly id = 'bridge-test';

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const modelId = typeof ref === 'string'
      ? ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
      : ref.model;
    return { ...MODEL, modelId, ref: { provider: this.id, model: modelId } };
  }

  async capabilities() {
    return mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, { streaming: true });
  }

  async generate(_request: ModelRequest, _context: ModelCallContext): Promise<ModelResponse> {
    return response();
  }

  stream(_request: ModelRequest, _context: ModelCallContext): ModelStream {
    const final = response();
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text.delta' as const, delta: 'bridge ' };
        yield { type: 'text.delta' as const, delta: 'ok' };
        yield { type: 'response.completed' as const, response: final };
      },
      finalResponse: async () => final,
      cancel: () => undefined,
    };
  }
}

function response(): ModelResponse {
  return {
    id: 'bridge-response',
    model: MODEL,
    output: [{ type: 'text', role: 'assistant', text: 'bridge ok' }],
    finishReason: 'stop',
    usage: usage(),
  };
}

function usage(): Usage {
  return {
    requests: 1,
    inputTokens: 2,
    outputTokens: 2,
    totalTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  };
}
