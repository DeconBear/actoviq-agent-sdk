import { describe, expect, it } from 'vitest';

import { CapabilityError, type InputItem, type OutputItem } from '../src/core/index.js';
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  AnthropicModelProvider,
  mergeModelCapabilities,
  OPENAI_CHAT_COMPAT_CAPABILITIES,
  OPENAI_RESPONSES_CAPABILITIES,
  OpenAIChatCompatProvider,
  OpenAIResponsesProvider,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ProviderTransport,
  type ProviderTransportRequest,
} from '../src/providers-v2/index.js';

type AdapterKind = 'responses' | 'chat' | 'anthropic';

interface AdapterContractHarness {
  readonly name: string;
  readonly kind: AdapterKind;
  readonly id: string;
  readonly baseCapabilities: ModelCapabilities;
  create(
    transport: ProviderTransport,
    capabilities?: ModelCapabilities,
    baseUrl?: string,
  ): ModelProvider;
}

const harnesses: readonly AdapterContractHarness[] = [
  {
    name: 'OpenAI Responses',
    kind: 'responses',
    id: 'openai-responses',
    baseCapabilities: OPENAI_RESPONSES_CAPABILITIES,
    create: (transport, capabilities = OPENAI_RESPONSES_CAPABILITIES, baseUrl) =>
      new OpenAIResponsesProvider({ transport, capabilities, baseUrl }),
  },
  {
    name: 'OpenAI Chat compat',
    kind: 'chat',
    id: 'openai-chat',
    baseCapabilities: OPENAI_CHAT_COMPAT_CAPABILITIES,
    create: (transport, capabilities = OPENAI_CHAT_COMPAT_CAPABILITIES, baseUrl) =>
      new OpenAIChatCompatProvider({ transport, capabilities, baseUrl }),
  },
  {
    name: 'Anthropic Messages',
    kind: 'anthropic',
    id: 'anthropic',
    baseCapabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
    create: (transport, capabilities = ANTHROPIC_MESSAGES_CAPABILITIES, baseUrl) =>
      new AnthropicModelProvider({ transport, capabilities, baseUrl }),
  },
];

/** Reusable contract kit; every protocol adapter is passed through the same assertions. */
function defineProviderContractSuite(harness: AdapterContractHarness): void {
  describe(`Provider v2 contract: ${harness.name}`, () => {
    it('resolves an explicit provider/model reference and declares capabilities without hostname inference', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(
        transport,
        fullTestCapabilities(harness.baseCapabilities),
        'https://unrelated-compatible-host.example/v1',
      );
      const model = await provider.resolve(ref(harness.id));
      const capabilities = await provider.capabilities(model);

      expect(model).toMatchObject({ providerId: harness.id, modelId: 'test-model' });
      expect(capabilities.input.image).toBe(true);
      expect(capabilities.output.structured).toBe(true);
      expect(capabilities.reasoning.opaqueRoundTrip).toBe(true);
      expect(transport.calls).toHaveLength(0);
    });

    it('round-trips canonical text and normalizes usage', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const response = await provider.generate(textRequest(harness.id), {});

      expect(findOutput(response.output, 'text')).toMatchObject({
        type: 'text',
        role: 'assistant',
        text: 'hello',
      });
      expect(response.usage).toMatchObject({
        requests: 1,
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      });
      expect(transport.calls).toHaveLength(1);
    });

    it('round-trips function tools, tool calls, results, and parallel policy', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const first = await provider.generate({
        ...textRequest(harness.id),
        tools: [{
          name: 'lookup',
          description: 'Looks up a value.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          strict: true,
        }],
        toolPolicy: 'required',
        parallelToolCalls: true,
      }, {});
      const toolCall = findOutput(first.output, 'tool_call');

      expect(toolCall).toMatchObject({
        type: 'tool_call',
        id: 'call_1',
        name: 'lookup',
        input: { query: 'sdk' },
      });

      await provider.generate({
        ...textRequest(harness.id),
        input: [
          toolCall as InputItem,
          {
            type: 'tool_result',
            callId: 'call_1',
            name: 'lookup',
            status: 'success',
            output: { value: 42 },
          },
        ],
      }, {});
      const serialized = JSON.stringify(transport.calls.at(-1)?.body);
      expect(serialized).toContain('call_1');
      expect(serialized).toContain('42');
    });

    it('round-trips structured output as both a response value and canonical item', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const response = await provider.generate({
        ...textRequest(harness.id),
        outputSchema: {
          name: 'answer',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
          strict: true,
        },
      }, {});

      expect(response.structuredOutput).toEqual({ answer: 'hello' });
      expect(findOutput(response.output, 'structured')).toMatchObject({
        type: 'structured',
        schemaName: 'answer',
        value: { answer: 'hello' },
      });
      expect(JSON.stringify(transport.calls[0]?.body)).toContain('json_schema');
    });

    it('maps canonical image input without losing URL or detail', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      await provider.generate({
        ...textRequest(harness.id),
        input: [{
          type: 'image',
          role: 'user',
          source: { kind: 'url', url: 'https://images.example/diagram.png' },
          detail: 'high',
          altText: 'architecture diagram',
        }],
      }, {});

      const serialized = JSON.stringify(transport.calls[0]?.body);
      expect(serialized).toContain('https://images.example/diagram.png');
      if (harness.kind !== 'anthropic') expect(serialized).toContain('high');
    });

    it('preserves opaque reasoning and can replay it to the same provider', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const response = await provider.generate({
        ...textRequest(harness.id),
        reasoning: { effort: 'high', summary: 'auto' },
      }, {});
      const reasoning = findOutput(response.output, 'reasoning');

      expect(reasoning).toMatchObject({ type: 'reasoning', provider: harness.id });
      expect(JSON.stringify(reasoning)).toContain('opaque-marker');

      await provider.generate({
        ...textRequest(harness.id),
        input: [reasoning as InputItem],
      }, {});
      expect(JSON.stringify(transport.calls.at(-1)?.body)).toContain('opaque-marker');
    });

    it('streams text and resolves the same canonical final response', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const stream = provider.stream(textRequest(harness.id), {});
      let streamedText = '';
      for await (const event of stream) {
        if (event.type === 'text.delta') streamedText += event.delta;
      }
      const response = await stream.finalResponse();

      expect(streamedText).toBe('hello');
      expect(findOutput(response.output, 'text')).toMatchObject({ text: 'hello' });
      expect(transport.calls[0]?.operation).toBe('stream');
    });

    it('throws CapabilityError before transport for an unsupported request', async () => {
      const transport = new SemanticTransport(harness.kind);
      const capabilities = mergeModelCapabilities(
        fullTestCapabilities(harness.baseCapabilities),
        { input: { image: false } },
      );
      const provider = harness.create(transport, capabilities);

      await expect(provider.generate({
        ...textRequest(harness.id),
        input: [{
          type: 'image',
          source: { kind: 'url', url: 'https://images.example/unsupported.png' },
        }],
      }, {})).rejects.toBeInstanceOf(CapabilityError);
      expect(transport.calls).toHaveLength(0);
    });

    it('preflights unsupported streaming lazily but still before transport', async () => {
      const transport = new SemanticTransport(harness.kind);
      const capabilities = mergeModelCapabilities(
        fullTestCapabilities(harness.baseCapabilities),
        { streaming: false },
      );
      const provider = harness.create(transport, capabilities);
      const stream = provider.stream(textRequest(harness.id), {});

      await expect(stream.finalResponse()).rejects.toMatchObject({
        code: 'CAPABILITY_ERROR',
        capability: expect.stringContaining('streaming'),
      });
      expect(transport.calls).toHaveLength(0);
    });

    it('rejects opaque items owned by another provider before transport', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));

      await expect(provider.generate({
        ...textRequest(harness.id),
        input: [{ type: 'raw', provider: 'different-provider', value: { opaque: true } }],
      }, {})).rejects.toMatchObject({
        code: 'CAPABILITY_ERROR',
        capability: 'providerRawRoundTrip',
      });
      expect(transport.calls).toHaveLength(0);
    });

    it('namespaces provider options and prevents them from overriding canonical fields', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      await provider.generate({
        ...textRequest(harness.id),
        providerOptions: {
          [harness.id]: {
            custom_option: 'kept',
            model: 'must-not-win',
            stream: true,
          },
        },
      }, {});

      expect(transport.calls[0]?.body).toMatchObject({
        custom_option: 'kept',
        model: 'test-model',
        stream: false,
      });
    });

    it('honors an already-aborted signal without invoking transport', async () => {
      const transport = new SemanticTransport(harness.kind);
      const provider = harness.create(transport, fullTestCapabilities(harness.baseCapabilities));
      const controller = new AbortController();
      controller.abort(new Error('contract abort'));

      await expect(provider.generate(textRequest(harness.id), {
        signal: controller.signal,
      })).rejects.toThrow('contract abort');
      expect(transport.calls).toHaveLength(0);
    });
  });
}

for (const harness of harnesses) defineProviderContractSuite(harness);

describe('Provider v2 explicit capability differences', () => {
  it('keeps Chat reasoning replay disabled by default while allowing an explicit model capability', async () => {
    const transport = new SemanticTransport('chat');
    const provider = new OpenAIChatCompatProvider({ transport });
    await expect(provider.generate({
      ...textRequest('openai-chat'),
      input: [{
        type: 'reasoning',
        provider: 'openai-chat',
        opaque: { reasoning_content: 'opaque-marker' },
      }],
    }, {})).rejects.toMatchObject({ code: 'CAPABILITY_ERROR' });
    expect(transport.calls).toHaveLength(0);
  });

  it('retains the full raw provider response only through explicit opt-in', async () => {
    const withoutRaw = new OpenAIResponsesProvider({
      transport: new SemanticTransport('responses'),
    });
    const withRaw = new OpenAIResponsesProvider({
      transport: new SemanticTransport('responses'),
      includeRawResponse: true,
    });

    await expect(withoutRaw.generate(textRequest('openai-responses'), {})).resolves.not.toHaveProperty('rawResponse');
    await expect(withRaw.generate(textRequest('openai-responses'), {})).resolves.toHaveProperty(
      'rawResponse.id',
      'resp_1',
    );
  });
});

class SemanticTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];

  constructor(private readonly kind: AdapterKind) {}

  async request(request: ProviderTransportRequest): Promise<unknown> {
    this.calls.push(request);
    return responseFixture(this.kind, hasStructuredRequest(this.kind, request.body));
  }

  stream(request: ProviderTransportRequest): AsyncIterable<unknown> {
    this.calls.push(request);
    return streamFixture(this.kind);
  }
}

function fullTestCapabilities(base: ModelCapabilities): ModelCapabilities {
  return mergeModelCapabilities(base, {
    input: { image: true },
    output: { structured: true },
    tools: { function: true, parallel: true },
    reasoning: { request: true, opaqueRoundTrip: true },
    streaming: true,
    providerRawRoundTrip: true,
  });
}

function textRequest(provider: string): ModelRequest {
  return {
    model: ref(provider),
    input: [{ type: 'text', role: 'user', text: 'hello' }],
    maxOutputTokens: 128,
  };
}

function ref(provider: string) {
  return { provider, model: 'test-model' } as const;
}

function findOutput(output: readonly OutputItem[], type: OutputItem['type']): OutputItem {
  const item = output.find(candidate => candidate.type === type);
  expect(item, `missing ${type} output`).toBeDefined();
  return item!;
}

function hasStructuredRequest(
  kind: AdapterKind,
  body: Readonly<Record<string, unknown>>,
): boolean {
  if (kind === 'responses') return isRecord(body.text);
  if (kind === 'chat') return isRecord(body.response_format);
  return isRecord(body.output_config) && isRecord(body.output_config.format);
}

function responseFixture(kind: AdapterKind, structured: boolean): unknown {
  const text = structured ? '{"answer":"hello"}' : 'hello';
  if (kind === 'responses') {
    return {
      id: 'resp_1',
      object: 'response',
      model: 'test-model',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'summary' }],
          encrypted_content: 'opaque-marker',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"query":"sdk"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    };
  }
  if (kind === 'chat') {
    return {
      id: 'chatcmpl_1',
      object: 'chat.completion',
      model: 'test-model',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: text,
          reasoning_content: { type: 'reasoning_blob', data: 'opaque-marker' },
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"sdk"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
  }
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [
      { type: 'thinking', thinking: 'summary', signature: 'opaque-marker' },
      { type: 'text', text },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'sdk' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

async function* streamFixture(kind: AdapterKind): AsyncGenerator<unknown> {
  if (kind === 'responses') {
    yield { type: 'response.output_text.delta', output_index: 0, delta: 'hel' };
    yield { type: 'response.output_text.delta', output_index: 0, delta: 'lo' };
    yield { type: 'response.completed', response: responseFixture('responses', false) };
    return;
  }
  if (kind === 'chat') {
    yield {
      id: 'chatcmpl_stream',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }],
    };
    yield {
      id: 'chatcmpl_stream',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    return;
  }
  yield {
    type: 'message_start',
    message: { id: 'msg_stream', usage: { input_tokens: 3, output_tokens: 0 } },
  };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } };
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 4 },
  };
  yield { type: 'message_stop' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
