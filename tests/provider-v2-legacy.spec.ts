import { describe, expect, it } from 'vitest';

import type { ModelApi, ModelRequest as LegacyRequest, ModelStreamHandle } from '../src/types.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import {
  LegacyModelApiProvider,
  ModelProviderLegacyAdapter,
  OpenAIResponsesProvider,
  type ProviderTransport,
  type ProviderTransportRequest,
} from '../src/providers-v2/index.js';

describe('LegacyModelApiProvider (old ModelApi -> Provider v2)', () => {
  it('maps canonical requests and legacy text/tool/reasoning responses without network access', async () => {
    const legacy = new FakeLegacyModelApi();
    const provider = new LegacyModelApiProvider({ modelApi: legacy });
    const response = await provider.generate({
      model: { provider: 'legacy', model: 'legacy-model' },
      input: [{ type: 'text', role: 'user', text: 'hello' }],
      tools: [{
        name: 'lookup',
        inputSchema: { type: 'object', properties: {} },
      }],
      maxOutputTokens: 256,
      reasoning: { effort: 'high' },
    }, {});

    expect(legacy.requests[0]).toMatchObject({
      model: 'legacy-model',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'legacy ok' }),
      expect.objectContaining({ type: 'tool_call', id: 'tool_1', name: 'lookup' }),
      expect.objectContaining({ type: 'reasoning', provider: 'legacy' }),
    ]));
    expect(response.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });

  it('adapts legacy stream deltas and finalMessage into ModelStream', async () => {
    const legacy = new FakeLegacyModelApi();
    const provider = new LegacyModelApiProvider({ modelApi: legacy });
    const stream = provider.stream({
      model: { provider: 'legacy', model: 'legacy-model' },
      input: [{ type: 'text', role: 'user', text: 'hello' }],
    }, {});
    let delta = '';
    for await (const event of stream) {
      if (event.type === 'text.delta') delta += event.delta;
    }

    expect(delta).toBe('legacy ok');
    await expect(stream.finalResponse()).resolves.toMatchObject({
      id: 'msg_legacy',
      finishReason: 'tool_calls',
    });
  });

  it('preflights unsupported structured output before calling the old ModelApi', async () => {
    const legacy = new FakeLegacyModelApi();
    const provider = new LegacyModelApiProvider({ modelApi: legacy });
    await expect(provider.generate({
      model: { provider: 'legacy', model: 'legacy-model' },
      input: [{ type: 'text', role: 'user', text: 'hello' }],
      outputSchema: { name: 'answer', schema: { type: 'object' } },
    }, {})).rejects.toMatchObject({ code: 'CAPABILITY_ERROR' });
    expect(legacy.requests).toHaveLength(0);
  });
});

describe('ModelProviderLegacyAdapter (Provider v2 -> old ModelApi)', () => {
  it('satisfies the old ModelApi contract used by createAgentSdk modelApi injection', async () => {
    const transport = new FakeResponsesTransport();
    const provider = new OpenAIResponsesProvider({ transport });
    const adapter: ModelApi = new ModelProviderLegacyAdapter(provider);
    const message = await adapter.createMessage(legacyRequest());

    expect(message).toMatchObject({
      id: 'resp_legacy_adapter',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'provider ok' }],
    });
    expect(transport.calls).toHaveLength(1);
    expect(JSON.stringify(transport.calls[0]?.body)).toContain('legacy hello');
  });

  it('translates Provider v2 stream events and final response to legacy events', async () => {
    const provider = new OpenAIResponsesProvider({ transport: new FakeResponsesTransport() });
    const adapter = new ModelProviderLegacyAdapter(provider);
    const stream = adapter.streamMessage(legacyRequest());
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const message = await stream.finalMessage();

    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes.at(-1)).toBe('message_stop');
    expect(message.content).toEqual([{ type: 'text', text: 'provider ok' }]);
  });
});

class FakeLegacyModelApi implements ModelApi {
  readonly requests: LegacyRequest[] = [];

  async createMessage(request: LegacyRequest): Promise<Message> {
    this.requests.push(request);
    return legacyMessage();
  }

  streamMessage(request: LegacyRequest): ModelStreamHandle {
    this.requests.push(request);
    return new FakeLegacyStream();
  }
}
class FakeLegacyStream implements ModelStreamHandle {
  async finalMessage(): Promise<Message> {
    return legacyMessage();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'legacy ok' },
    };
  }
}

function legacyMessage(): Message {
  return {
    id: 'msg_legacy',
    type: 'message',
    role: 'assistant',
    model: 'legacy-model',
    content: [
      { type: 'thinking', thinking: 'opaque reasoning', signature: 'sig' },
      { type: 'text', text: 'legacy ok' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'sdk' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 2, output_tokens: 3 },
  };
}

class FakeResponsesTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];

  async request(request: ProviderTransportRequest): Promise<unknown> {
    this.calls.push(request);
    return responsesMessage();
  }

  stream(request: ProviderTransportRequest): AsyncIterable<unknown> {
    this.calls.push(request);
    return (async function* () {
      yield { type: 'response.output_text.delta', output_index: 0, delta: 'provider ok' };
      yield { type: 'response.completed', response: responsesMessage() };
    })();
  }
}

function responsesMessage() {
  return {
    id: 'resp_legacy_adapter',
    object: 'response',
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'provider ok' }],
    }],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  };
}

function legacyRequest(): LegacyRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'legacy hello' }],
    max_tokens: 128,
  };
}
