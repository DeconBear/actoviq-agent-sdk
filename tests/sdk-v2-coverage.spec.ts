import { describe, expect, it, vi } from 'vitest';

import type { InputItem, JsonObject, OutputItem } from '../src/core/index.js';
import {
  compactObject,
  joinEndpoint,
  isRecord,
  asString,
  safeJsonParse,
  stringifyToolValue,
} from '../src/providers-v2/adapter-base.js';
import {
  attachStructuredOutput,
  finishReason,
  imageSourceParts,
  jsonObject,
  jsonValue,
  providerRawInput,
  rawOutput,
  reasoningOutput,
  refusalOutput,
  structuredOutput,
  textOutput,
  toolCallOutput,
  usageFromProvider,
  zeroUsage,
} from '../src/providers-v2/mapping.js';
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  AnthropicModelProvider,
  assertRequestCapabilities,
  createModelRef,
  FetchProviderTransport,
  hasCapability,
  mergeModelCapabilities,
  MINIMAL_MODEL_CAPABILITIES,
  modelRefParts,
  ModelRegistry,
  OpenAIChatCompatProvider,
  OPENAI_CHAT_COMPAT_CAPABILITIES,
  OpenAIResponsesProvider,
  OPENAI_RESPONSES_CAPABILITIES,
  requiredCapabilitiesForRequest,
  resolveModelCapabilities,
  unsupportedCapabilities,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderTransport,
  type ProviderTransportRequest,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import { createModelStream } from '../src/providers-v2/stream.js';

describe('Provider v2 exhaustive public contracts', () => {
  it('covers provider-neutral mapping fallbacks without lossy JSON values', () => {
    expect(compactObject({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
    expect(joinEndpoint('https://example.test/v1', 'responses')).toBe('https://example.test/v1/responses');
    expect(joinEndpoint('https://example.test/v1', '/responses')).toBe('https://example.test/v1/responses');
    expect(joinEndpoint('https://example.test/v1/RESPONSES', '/responses')).toBe('https://example.test/v1/RESPONSES');
    expect([isRecord({}), isRecord(null), isRecord([])]).toEqual([true, false, false]);
    expect(asString('x', 'fallback')).toBe('x');
    expect(asString(1, 'fallback')).toBe('fallback');
    expect(safeJsonParse({ value: true })).toEqual({ value: true });
    expect(safeJsonParse('{"value":true}')).toEqual({ value: true });
    expect(safeJsonParse('{bad')).toBe('{bad');
    expect(stringifyToolValue('text')).toBe('text');
    expect(stringifyToolValue(undefined)).toBe('null');
    expect(stringifyToolValue({ ok: true })).toBe('{"ok":true}');

    const imageCases = [
      { type: 'image', role: 'assistant', source: { kind: 'url', url: 'https://image' }, detail: 'low' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' }, detail: 'invalid' },
      { type: 'image', source: { kind: 'file', fileId: 'file-1' }, detail: 'auto' },
      { type: 'image', source: null, url: 'https://fallback', detail: 'high' },
    ] as unknown as InputItem[];
    expect(imageCases.map(imageSourceParts)).toEqual([
      expect.objectContaining({ kind: 'url', role: 'assistant', url: 'https://image', detail: 'low' }),
      expect.objectContaining({ kind: 'base64', role: 'user', mediaType: 'image/png', data: 'abc', detail: undefined }),
      expect.objectContaining({ kind: 'file', fileId: 'file-1', detail: 'auto' }),
      expect.objectContaining({ kind: 'url', url: 'https://fallback', detail: 'high' }),
    ]);

    expect(textOutput('text')).toMatchObject({ type: 'text', text: 'text' });
    expect(toolCallOutput('call', 'tool', null)).toMatchObject({ input: {} });
    expect(toolCallOutput('call', 'tool', 4)).toMatchObject({ input: { raw: 4 } });
    expect(reasoningOutput('p', { opaque: true })).not.toHaveProperty('summary');
    expect(reasoningOutput('p', { opaque: true }, 'summary')).toHaveProperty('summary', 'summary');
    expect(rawOutput('p', undefined)).toMatchObject({ value: 'undefined' });
    expect(refusalOutput('no')).not.toHaveProperty('providerData');
    expect(refusalOutput('no', { code: 1 })).toHaveProperty('providerData.code', 1);
    expect(providerRawInput({ type: 'raw', provider: 'p', value: { raw: true } })).toEqual({ raw: true });

    expect(usageFromProvider({
      nested: { input: 2, cached: 1 }, output: 3, total: 8, write: 2, thought: 4,
    }, {
      input: ['missing', 'nested.input'], output: ['output'], total: ['total'],
      cachedInput: ['nested.cached'], cacheWrite: ['write'], reasoning: ['thought'],
    })).toMatchObject({
      inputTokens: 2, outputTokens: 3, totalTokens: 8,
      cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 4,
    });
    expect(usageFromProvider(null, { input: [], output: [] })).toMatchObject({ totalTokens: 0 });
    expect(usageFromProvider({ input: Number.NaN, output: 2 }, {
      input: ['input'], output: ['output'],
    })).toMatchObject({ inputTokens: 0, outputTokens: 2, totalTokens: 2 });
    expect(zeroUsage()).toMatchObject({ requests: 1, totalTokens: 0 });

    const request = requestFor('provider');
    expect(structuredOutput(request, [textOutput('{}')])).toBeUndefined();
    const schemaRequest = { ...request, outputSchema: { name: 'value', schema: { type: 'object' } } };
    expect(structuredOutput(schemaRequest, [])).toBeUndefined();
    expect(structuredOutput(schemaRequest, [textOutput('{bad')])).toBeUndefined();
    expect(structuredOutput(schemaRequest, [textOutput('{'), textOutput('"ok":true}')])).toEqual({ ok: true });
    const output: OutputItem[] = [textOutput('{"ok":true}')];
    expect(attachStructuredOutput(schemaRequest, output)).toEqual({ ok: true });
    expect(output.at(-1)).toMatchObject({ type: 'structured', schemaName: 'value' });
    expect(attachStructuredOutput(request, output)).toBeUndefined();

    for (const [value, expected] of [
      ['stop', 'stop'], ['end_turn', 'stop'], ['completed', 'stop'],
      ['length', 'length'], ['max_tokens', 'length'], ['max_output_tokens', 'length'], ['incomplete', 'length'],
      ['tool_calls', 'tool_calls'], ['tool_use', 'tool_calls'], ['content_filter', 'content_filter'],
      ['refusal', 'refusal'], ['cancelled', 'cancelled'], ['canceled', 'cancelled'],
      ['failed', 'error'], ['error', 'error'], ['other', 'unknown'],
    ] as const) expect(finishReason(value)).toBe(expected);

    expect(jsonObject({ a: undefined, b: Number.POSITIVE_INFINITY, c: [1, null] })).toEqual({
      b: 'Infinity', c: [1, null],
    });
    expect(jsonObject(null)).toEqual({});
    expect(jsonObject('raw')).toEqual({ raw: 'raw' });
    expect(jsonValue(true)).toBe(true);
    expect(jsonValue(2)).toBe(2);
    expect(jsonValue(Symbol.for('x'))).toBe('Symbol(x)');
  });

  it('enumerates every capability source, modality, reference, and failure path', async () => {
    const all = allCapabilities(MINIMAL_MODEL_CAPABILITIES);
    const model = resolved('provider');
    expect(await resolveModelCapabilities(undefined, all, model)).toBe(all);
    expect(await resolveModelCapabilities(
      async () => mergeModelCapabilities(all, { streaming: false }), all, model,
    ))
      .toMatchObject({ streaming: false, input: all.input });
    expect(await resolveModelCapabilities(all, MINIMAL_MODEL_CAPABILITIES, model)).toMatchObject(all);
    expect(await resolveModelCapabilities({
      exact: mergeModelCapabilities(all, { streaming: false }),
      '*': mergeModelCapabilities(all, { promptCaching: false }),
    }, all, { ...model, modelId: 'exact' })).toMatchObject({ streaming: false });
    expect(await resolveModelCapabilities({
      '*': mergeModelCapabilities(all, { promptCaching: false }),
    }, all, model))
      .toMatchObject({ promptCaching: false });
    expect(await resolveModelCapabilities({}, all, model)).toMatchObject(all);

    const rich = {
      ...requestFor('provider'),
      input: [
        { type: 'text', role: 'user', text: 'x' },
        { type: 'image', source: { kind: 'url', url: 'https://x' } },
        { type: 'audio', source: { kind: 'url', url: 'https://x' } },
        { type: 'document', source: { kind: 'url', url: 'https://x' } },
        { type: 'artifact_ref', artifactId: 'a' },
        { type: 'tool_call', id: 'c', name: 't', input: {} },
        { type: 'tool_result', callId: 'c', status: 'success', output: null },
        { type: 'reasoning', provider: 'provider', opaque: {} },
        { type: 'structured', role: 'assistant', value: {} },
        { type: 'refusal', role: 'assistant', message: 'no' },
        { type: 'error', source: 'model', code: 'E', message: 'x', retryable: false },
        { type: 'raw', provider: 'provider', value: {} },
        { type: 'unknown' },
      ] as InputItem[],
      outputSchema: { name: 'out', schema: {} },
      reasoning: { effort: 'high' as const },
      promptCacheKey: 'cache',
      stopSequences: ['stop'],
      tools: [{ name: 'hosted', inputSchema: {}, hosted: true }],
      parallelToolCalls: true,
      outputModalities: ['text', 'image', 'audio'] as const,
    };
    const required = requiredCapabilitiesForRequest(rich, { streaming: true });
    expect(required).toEqual(expect.arrayContaining([
      'streaming', 'output.structured', 'reasoning.request', 'promptCaching', 'stopSequences',
      'tools.function', 'tools.hosted', 'tools.parallel', 'input.image', 'input.audio',
      'input.document', 'input.artifact', 'reasoning.opaqueRoundTrip', 'providerRawRoundTrip',
      'output.image', 'output.audio',
    ]));
    expect(unsupportedCapabilities(MINIMAL_MODEL_CAPABILITIES, required)).toContain('streaming');
    expect(() => assertRequestCapabilities('provider', model, MINIMAL_MODEL_CAPABILITIES, rich, { streaming: true }))
      .toThrow(/does not support required capabilities/);
    expect(() => assertRequestCapabilities('provider', model, all, rich, { streaming: true })).not.toThrow();
    expect(() => assertRequestCapabilities('provider', model, all, {
      ...requestFor('provider'), input: [{ type: 'raw', provider: 'other', value: {} }],
    })).toThrow(/cannot be sent/);
    expect(hasCapability(all, 'streaming')).toBe(true);
    expect(hasCapability(all, 'input.image')).toBe(true);
    expect(hasCapability(all, 'missing.value' as any)).toBe(false);

    expect(modelRefParts('provider:model')).toEqual({ providerId: 'provider', modelId: 'model' });
    expect(modelRefParts('model', 'default')).toEqual({ providerId: 'default', modelId: 'model' });
    expect(modelRefParts({ provider: 'p', model: 'm' })).toEqual({ providerId: 'p', modelId: 'm' });
    expect(modelRefParts({ providerId: 'p', modelId: 'm' } as any)).toEqual({ providerId: 'p', modelId: 'm' });
    expect(modelRefParts({ provider: 'p', id: 'm' } as any)).toEqual({ providerId: 'p', modelId: 'm' });
    expect(() => modelRefParts('')).toThrow(/provider:model/);
    expect(() => modelRefParts('p:')).toThrow(/provider:model/);
    expect(() => modelRefParts({ provider: '', model: '' } as any)).toThrow(/non-empty/);
    expect(createModelRef('p', 'm')).toEqual({ provider: 'p', model: 'm' });
  });

  it('validates provider ownership and all registry routing forms', async () => {
    const provider = new OpenAIResponsesProvider({
      id: 'custom', transport: new QueueTransport([responsesMinimal()]),
      capabilities: allCapabilities(OPENAI_RESPONSES_CAPABILITIES),
      baseUrl: 'https://example.test/v1/responses///',
    });
    await expect(provider.resolve({ provider: 'other', model: 'm' })).rejects.toThrow(/cannot resolve/);
    await expect(provider.capabilities(resolved('other'))).rejects.toThrow(/belongs to/);
    await expect(provider.generate({
      ...requestFor('custom'), model: resolved('other'),
    }, {})).rejects.toThrow(/belongs to/);

    const registry = new ModelRegistry([provider], { defaultProviderId: 'custom' });
    expect(registry.has('custom')).toBe(true);
    expect(registry.list()).toEqual([provider]);
    expect(await registry.capabilities('m')).toMatchObject({ streaming: true });
    expect(await registry.capabilities(resolved('custom'))).toMatchObject({ streaming: true });
    expect(registry.providerFor(resolved('custom'))).toBe(provider);
    expect(registry.stream(requestFor('custom'))).toBeDefined();
    expect(registry.unregister('missing')).toBe(false);
    const empty = new ModelRegistry();
    expect(() => empty.get('missing')).toThrow(/\(none\)/);
    const second = new OpenAIResponsesProvider({ id: 'second', transport: new QueueTransport() });
    const ambiguous = new ModelRegistry([provider, second]);
    await expect(ambiguous.resolve('model')).rejects.toThrow(/provider:model/);
  });

  it('enforces lazy stream single-consumer, cancellation, parent abort, and failure settlement', async () => {
    const response = modelResponse('stream');
    const state = { mapped: 0 };
    const stream = createModelStream<{ mapped: number }>({
      context: {},
      start: async () => (async function* () { yield 'a'; yield 'complete'; })(),
      mapper: {
        state,
        map(event: unknown, current: { mapped: number }) {
          current.mapped += 1;
          return event === 'complete'
            ? [{ type: 'response.completed', response }]
            : [{ type: 'text.delta', delta: String(event) }];
        },
        finalize: () => response,
      },
    } as any);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.at(-1)?.type).toBe('response.completed');
    await expect(stream.finalResponse()).resolves.toBe(response);
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/single-consumer/);
    stream.cancel('after completion');

    const drain = createModelStream({
      context: {},
      start: () => (async function* () { yield 1; })(),
      mapper: { state: {}, map: () => [], finalize: () => response },
    });
    await expect(drain.finalResponse()).resolves.toBe(response);

    const cancelled = createModelStream({
      context: {},
      start: () => (async function* () { yield 1; })(),
      mapper: { state: {}, map: () => [], finalize: () => response },
    });
    cancelled.cancel();
    await expect(cancelled.finalResponse()).rejects.toMatchObject({ name: 'AbortError' });

    const parent = new AbortController();
    parent.abort(new Error('parent stopped'));
    const parentAborted = createModelStream({
      context: { signal: parent.signal },
      start: () => (async function* () {})(),
      mapper: { state: {}, map: () => [], finalize: () => response },
    });
    await expect(parentAborted.finalResponse()).rejects.toThrow('parent stopped');

    const failure = createModelStream({
      context: {},
      start: () => (async function* () { throw new Error('source failed'); })(),
      mapper: { state: {}, map: () => [], finalize: () => response },
    });
    await expect(failure.finalResponse()).rejects.toThrow('source failed');
  });

  it('covers JSON, SSE, retry, timeout, and error-body transport boundaries', async () => {
    const request = transportRequest();
    const invalidJson = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad', { status: 200 })),
      maxRetries: 0,
    });
    await expect(invalidJson.request(request, {})).rejects.toMatchObject({
      code: 'PROVIDER_TRANSPORT_ERROR', status: 200, retryable: false,
    });

    const jsonStream = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{"single":true}', {
        headers: { 'content-type': 'application/json' },
      })),
    });
    const jsonEvents = [];
    for await (const event of jsonStream.stream({ ...request, operation: 'stream' }, {})) jsonEvents.push(event);
    expect(jsonEvents).toEqual([{ single: true }]);

    const noBody = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
        headers: { 'content-type': 'text/event-stream' },
      })),
    });
    await expect((async () => {
      for await (const _event of noBody.stream({ ...request, operation: 'stream' }, {})) void _event;
    })()).rejects.toThrow(/without a response body/);

    const sse = [
      'event: custom',
      'data: {"value":1}',
      '',
      'data: [1,2]',
      '',
      'event: broken',
      'data: not-json',
      '',
      'data: [DONE]',
      '',
      'event: trailing',
      'data: {"tail":true}',
    ].join('\n');
    const sseTransport = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(sse, {
        headers: { 'content-type': 'text/event-stream' },
      })),
    });
    const sseEvents = [];
    for await (const event of sseTransport.stream({ ...request, operation: 'stream' }, {})) sseEvents.push(event);
    expect(sseEvents).toEqual([
      { type: 'custom', value: 1 }, [1, 2], { type: 'broken', data: 'not-json' },
      { type: 'done' }, { type: 'trailing', tail: true },
    ]);

    for (const status of [408, 409, 429, 500]) {
      const transport = new FetchProviderTransport({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })),
        maxRetries: 0,
      });
      await expect(transport.request(request, {})).rejects.toMatchObject({ status, retryable: true });
    }
    for (const body of [
      { body: { error: { message: 'nested' } }, expected: 'nested' },
      { body: { message: 'top' }, expected: 'top' },
      { body: { error: 'unknown' }, expected: 'HTTP 400' },
    ]) {
      const transport = new FetchProviderTransport({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body.body), { status: 400 })),
        maxRetries: 0,
      });
      await expect(transport.request(request, {})).rejects.toThrow(body.expected);
    }

    for (const retryAfter of [
      { 'retry-after-ms': '3' }, { 'retry-after': '0.004' },
      { 'retry-after': new Date(Date.now() + 5).toUTCString() }, { 'retry-after': 'invalid' },
    ]) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', {
          status: 503,
          headers: new Headers(
            Object.entries(retryAfter)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ),
        }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
      const sleep = vi.fn(async () => {});
      await expect(new FetchProviderTransport({
        fetch: fetchImpl, maxRetries: 1, retryBaseDelayMs: 1, maxRetryDelayMs: 10,
        random: () => 1, sleep,
      }).request(request, {})).resolves.toEqual({ ok: true });
      expect(sleep).toHaveBeenCalledOnce();
    }

    for (const error of [
      new TypeError('fetch failed'),
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      new Error('network terminated'),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
      await expect(new FetchProviderTransport({
        fetch: fetchImpl, maxRetries: 1, retryBaseDelayMs: 0, sleep: async () => {},
      }).request(request, {})).resolves.toEqual({ ok: true });
    }
    const nonRetryable = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockRejectedValue('plain failure'), maxRetries: 2,
    });
    await expect(nonRetryable.request(request, {})).rejects.toMatchObject({ retryable: false });

    const timed = new FetchProviderTransport({
      timeoutMs: 2,
      maxRetries: 0,
      fetch: vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })),
    });
    await expect(timed.request(request, {})).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('covers default retry delay cancellation and nested transport error classification', async () => {
    const request = transportRequest();
    const defaultDelayFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(new FetchProviderTransport({
      fetch: defaultDelayFetch, maxRetries: 1, retryBaseDelayMs: 1, maxRetryDelayMs: 1,
      random: () => 0,
    }).request(request, {})).resolves.toEqual({ ok: true });

    const abort = new AbortController();
    const retrying = new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
      maxRetries: 1, retryBaseDelayMs: 1_000,
    }).request(request, { signal: abort.signal });
    await Promise.resolve();
    abort.abort(new Error('cancel retry delay'));
    await expect(retrying).rejects.toThrow('cancel retry delay');

    const nested = new Error('outer', {
      cause: Object.assign(new Error('inner'), { code: 'ETIMEDOUT' }),
    });
    await expect(new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(nested), maxRetries: 0,
    }).request(request, {})).rejects.toMatchObject({ retryable: true });
    const abortError = new Error('fetch aborted');
    abortError.name = 'AbortError';
    await expect(new FetchProviderTransport({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(abortError), maxRetries: 0,
    }).request(request, {})).rejects.toBe(abortError);
  });
});

describe('Provider protocol branch matrix', () => {
  const harnesses = [
    {
      id: 'openai-responses',
      base: OPENAI_RESPONSES_CAPABILITIES,
      create: (transport: ProviderTransport, options: Record<string, unknown> = {}) =>
        new OpenAIResponsesProvider({ transport, ...options }),
      response: responsesRich,
    },
    {
      id: 'openai-chat',
      base: OPENAI_CHAT_COMPAT_CAPABILITIES,
      create: (transport: ProviderTransport, options: Record<string, unknown> = {}) =>
        new OpenAIChatCompatProvider({ transport, ...options }),
      response: chatRich,
    },
    {
      id: 'anthropic',
      base: ANTHROPIC_MESSAGES_CAPABILITIES,
      create: (transport: ProviderTransport, options: Record<string, unknown> = {}) =>
        new AnthropicModelProvider({ transport, ...options }),
      response: anthropicRich,
    },
  ] as const;

  for (const harness of harnesses) {
    it(`${harness.id} maps every portable input and optional request field`, async () => {
      const transport = new QueueTransport(Array.from({ length: 6 }, () => protocolMinimal(harness.id)));
      const provider = harness.create(transport, {
        capabilities: allCapabilities(harness.base),
        apiKey: 'api-key', authToken: harness.id === 'anthropic' ? undefined : 'auth-token',
        baseUrl: 'https://compatible.example/v1/',
      });
      const inputs = portableInputs(harness.id);
      const policies = [
        undefined, 'auto', 'none', 'required', { type: 'tool', name: 'lookup' },
      ] as const;
      for (const policy of policies) {
        await provider.generate({
          model: { provider: harness.id, model: 'model' },
          input: inputs,
          tools: [
            { name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' }, strict: false },
            { name: 'web_search', inputSchema: {}, hosted: true, providerOptions: { type: 'web_search_preview' } },
          ],
          toolPolicy: policy,
          parallelToolCalls: policy === 'none' ? false : true,
          outputSchema: {
            name: 'answer', description: 'Answer schema', schema: { type: 'object' }, strict: false,
          },
          reasoning: { effort: 'max', summary: 'none', budgetTokens: 32 },
          maxOutputTokens: 10,
          temperature: 0,
          stopSequences: ['stop'],
          promptCacheKey: 'cache',
          metadata: { trace: 'one' },
          providerOptions: { [harness.id]: { custom: true, model: 'cannot-win' } },
        }, {});
      }
      expect(transport.calls).toHaveLength(5);
      const serialized = JSON.stringify(transport.calls.map(call => call.body));
      expect(serialized).toContain('lookup');
      expect(serialized).not.toContain('cannot-win');
      expect(transport.calls.every(call => call.body.model === 'model')).toBe(true);
      expect(transport.calls[0]?.url).toMatch(/compatible\.example/);
    });

    it(`${harness.id} parses rich output, raw opt-in, preservation opt-out, and invalid envelopes`, async () => {
      const richTransport = new QueueTransport([harness.response()]);
      const rich = harness.create(richTransport, {
        capabilities: allCapabilities(harness.base), includeRawResponse: true,
      });
      const result = await rich.generate(requestFor(harness.id), {});
      expect(result.rawResponse).toBeDefined();
      expect(result.output.length).toBeGreaterThan(2);

      const lean = harness.create(new QueueTransport([harness.response()]), {
        capabilities: allCapabilities(harness.base), preserveProviderItems: false,
      });
      const leanResult = await lean.generate(requestFor(harness.id), {});
      expect(leanResult.output.filter(item => item.type === 'raw')).toHaveLength(0);

      const invalid = harness.create(new QueueTransport([null]), {
        capabilities: allCapabilities(harness.base),
      });
      await expect(invalid.generate(requestFor(harness.id), {})).rejects.toThrow(/non-object/);
    });
  }

  it('maps advanced OpenAI Responses stream events and fallback finalization', async () => {
    const provider = new OpenAIResponsesProvider({
      transport: new QueueTransport([], [[
        null,
        { type: 'response.output_text.delta', delta: 'hello', output_index: 0 },
        { type: 'response.function_call_arguments.delta', delta: '{"x":', item_id: 'call-a', name: 'lookup', output_index: 1 },
        { type: 'response.function_call_arguments.delta', delta: '1}', call_id: 'call-a', output_index: 1 },
        { type: 'response.reasoning_summary_text.delta', delta: 'why', output_index: 2 },
        { type: 'response.reasoning_text.delta', delta: ' now', output_index: 'bad' },
        { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
        { type: 'done' },
      ]]),
      capabilities: allCapabilities(OPENAI_RESPONSES_CAPABILITIES),
    });
    const stream = provider.stream(requestFor('openai-responses'), {});
    const events = [];
    for await (const event of stream) events.push(event);
    const final = await stream.finalResponse();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text.delta' }),
      expect.objectContaining({ type: 'tool_call.delta' }),
      expect.objectContaining({ type: 'reasoning.delta' }),
    ]));
    expect(final.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_call', id: 'call-a' }),
      expect.objectContaining({ type: 'reasoning' }),
    ]));

    for (const event of [
      { type: 'response.completed', response: responsesMinimal() },
      { type: 'response.failed', response: { ...responsesMinimal(), status: 'failed' } },
      { type: 'response.incomplete', response: { ...responsesMinimal(), status: 'incomplete' } },
      responsesMinimal(),
    ]) {
      const current = new OpenAIResponsesProvider({
        transport: new QueueTransport([], [[event]]),
        capabilities: allCapabilities(OPENAI_RESPONSES_CAPABILITIES),
        preserveProviderItems: false,
      }).stream(requestFor('openai-responses'), {});
      await expect(current.finalResponse()).resolves.toHaveProperty('id');
    }
  });

  it('maps advanced Chat stream deltas, tool fragments, full response, and usage', async () => {
    const provider = new OpenAIChatCompatProvider({
      transport: new QueueTransport([], [[
        null,
        { choices: [null, { index: 0, delta: { content: 'hi', reasoning: 'why', tool_calls: [
          null,
          { index: 0, id: 'call', function: { name: 'look', arguments: '{"x":' } },
          { index: 0, function: { name: 'up', arguments: '1}' } },
          { index: 'bad', function: {} },
        ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]]),
      capabilities: allCapabilities(OPENAI_CHAT_COMPAT_CAPABILITIES),
    });
    const final = await provider.stream(requestFor('openai-chat'), {}).finalResponse();
    expect(final.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
      expect.objectContaining({ type: 'reasoning', summary: 'why' }),
      expect.objectContaining({ type: 'tool_call', id: 'call', name: 'lookup' }),
    ]));

    const completed = new OpenAIChatCompatProvider({
      transport: new QueueTransport([], [[chatRich()]]),
      capabilities: allCapabilities(OPENAI_CHAT_COMPAT_CAPABILITIES),
    }).stream(requestFor('openai-chat'), {});
    await expect(completed.finalResponse()).resolves.toHaveProperty('id', 'chat-rich');
  });

  it('maps every Anthropic stream block/delta and both completion forms', async () => {
    const provider = new AnthropicModelProvider({
      transport: new QueueTransport([], [[
        null,
        { type: 'message_start', message: { id: 'stream-id', usage: { input_tokens: 2 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: 's0' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: { initial: true } } },
        { type: 'content_block_start', index: 3, content_block: { type: 'future' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'late' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'why' } },
        { type: 'content_block_delta', index: 5, delta: { type: 'thinking_delta', thinking: 'late reason' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 's1' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
        { type: 'content_block_delta', index: 6, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      ]]),
      capabilities: allCapabilities(ANTHROPIC_MESSAGES_CAPABILITIES),
    });
    const final = await provider.stream(requestFor('anthropic'), {}).finalResponse();
    expect(final.id).toBe('stream-id');
    expect(final.finishReason).toBe('tool_calls');
    expect(final.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'reasoning' }),
      expect.objectContaining({ type: 'tool_call', id: 'call' }),
      expect.objectContaining({ type: 'raw' }),
    ]));

    for (const type of ['message', 'message_completed']) {
      const completed = new AnthropicModelProvider({
        transport: new QueueTransport([], [[{ type, message: anthropicRich() }]]),
        capabilities: allCapabilities(ANTHROPIC_MESSAGES_CAPABILITIES),
      }).stream(requestFor('anthropic'), {});
      await expect(completed.finalResponse()).resolves.toHaveProperty('id', 'anthropic-rich');
    }
  });

  it('applies Anthropic prompt caching to non-system message variants and both credentials', async () => {
    const transport = new QueueTransport([
      protocolMinimal('anthropic'), protocolMinimal('anthropic'), protocolMinimal('anthropic'),
    ]);
    const auth = new AnthropicModelProvider({
      transport, authToken: 'token', capabilities: allCapabilities(ANTHROPIC_MESSAGES_CAPABILITIES),
    });
    await auth.generate({
      ...requestFor('anthropic'), promptCacheKey: 'cache',
    }, {});
    await auth.generate({
      ...requestFor('anthropic'), promptCacheKey: 'cache',
      input: [{ type: 'handoff_call', id: 'h', targetAgentId: 'a', input: null }],
    }, {});
    await auth.generate({
      ...requestFor('anthropic'), promptCacheKey: 'cache',
      input: [{
        type: 'raw', provider: 'anthropic',
        value: { role: 'user', content: [3] },
      }],
    }, {});
    expect(transport.calls[0]?.headers.authorization).toBe('Bearer token');
    expect(JSON.stringify(transport.calls[0]?.body)).toContain('cache_control');

    const apiKeyTransport = new QueueTransport([protocolMinimal('anthropic')]);
    await new AnthropicModelProvider({
      transport: apiKeyTransport, apiKey: 'key',
      capabilities: allCapabilities(ANTHROPIC_MESSAGES_CAPABILITIES),
    }).generate(requestFor('anthropic'), {});
    expect(apiKeyTransport.calls[0]?.headers['x-api-key']).toBe('key');
  });
});

class QueueTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];
  constructor(
    private readonly responses: unknown[] = [],
    private readonly streams: unknown[][] = [],
  ) {}
  async request(request: ProviderTransportRequest): Promise<unknown> {
    this.calls.push(request);
    return this.responses.length > 0 ? this.responses.shift() : responsesMinimal();
  }
  stream(request: ProviderTransportRequest): AsyncIterable<unknown> {
    this.calls.push(request);
    const events = this.streams.shift() ?? [];
    return (async function* () { for (const event of events) yield event; })();
  }
}

function requestFor(provider: string): ModelRequest {
  return {
    model: { provider, model: 'model' },
    input: [{ type: 'text', role: 'user', text: 'hello' }],
  };
}

function resolved(provider: string): ResolvedModel {
  return { providerId: provider, modelId: 'model', ref: { provider, model: 'model' } };
}

function modelResponse(provider: string): ModelResponse {
  return {
    id: 'response', model: resolved(provider), output: [textOutput('ok')], finishReason: 'stop',
    usage: zeroUsage(),
  };
}

function allCapabilities(base: ModelCapabilities): ModelCapabilities {
  return mergeModelCapabilities(base, {
    input: { text: true, image: true, audio: true, document: true, artifact: true },
    output: { text: true, image: true, audio: true, structured: true },
    tools: { function: true, parallel: true, hosted: true },
    reasoning: { request: true, opaqueRoundTrip: true },
    streaming: true, promptCaching: true, stopSequences: true, providerRawRoundTrip: true,
  });
}

function portableInputs(provider: string): InputItem[] {
  return [
    { type: 'text', role: 'system', text: 'system' },
    { type: 'text', role: 'user', text: 'user' },
    { type: 'text', role: 'assistant', text: 'assistant' },
    { type: 'image', role: 'user', source: { kind: 'url', url: 'https://image' }, detail: 'high' },
    { type: 'image', role: 'assistant', source: { kind: 'base64', mediaType: 'image/png', data: 'abc' } },
    { type: 'image', source: { kind: 'file', fileId: 'file-1' } },
    { type: 'document', role: 'user', source: { kind: 'url', url: 'https://doc' } },
    { type: 'document', source: { kind: 'base64', mediaType: 'application/pdf', data: 'pdf' } },
    { type: 'document', source: { kind: 'file', fileId: 'file-doc' } },
    { type: 'tool_call', id: 'call', name: 'lookup', input: { x: 1 } },
    { type: 'tool_result', callId: 'call', status: 'error', output: { error: true } },
    { type: 'reasoning', provider, summary: 'why', opaque: { type: 'reasoning', value: true } },
    { type: 'raw', provider, value: { role: 'assistant', content: [{ type: 'future' }] } },
    { type: 'structured', role: 'assistant', value: { answer: true } },
    { type: 'refusal', role: 'assistant', message: 'no' },
    { type: 'error', source: 'model', code: 'E', message: 'bad', retryable: false },
    { type: 'handoff_call', id: 'h', targetAgentId: 'next', input: null },
  ];
}

function protocolMinimal(provider: string): unknown {
  if (provider === 'openai-chat') return {
    id: 'chat-minimal', choices: [{ finish_reason: 'stop', message: { content: '{"answer":true}' } }],
  };
  if (provider === 'anthropic') return {
    id: 'anthropic-minimal', content: [{ type: 'text', text: '{"answer":true}' }], stop_reason: 'end_turn',
  };
  return {
    id: 'responses-minimal', status: 'completed', output: [{
      type: 'message', content: [{ type: 'output_text', text: '{"answer":true}' }],
    }],
  };
}

function responsesMinimal(): Record<string, unknown> {
  return protocolMinimal('openai-responses') as Record<string, unknown>;
}

function responsesRich(): unknown {
  return {
    id: 'responses-rich', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [
      null,
      { type: 'message', content: [
        null, { type: 'output_text', text: 'hello' }, { type: 'output_text', text: 4 },
        { type: 'refusal', refusal: 'no' }, { type: 'future', value: true },
      ] },
      { type: 'function_call', id: 'fallback-call', name: 'lookup', arguments: '{bad' },
      { type: 'reasoning', summary: [null, { text: 3 }, { text: 'summary' }] },
      { type: 'future_output', value: true },
    ],
    usage: {
      input_tokens: 4, output_tokens: 5, total_tokens: 9,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
    },
  };
}

function chatRich(): unknown {
  return {
    id: 'chat-rich', object: 'chat.completion',
    choices: [{ finish_reason: 'refusal', message: {
      content: [
        null, { type: 'text', text: 'hello' }, { type: 'output_text', text: ' world' },
        { type: 'refusal', text: 'part refused' }, { type: 'future', value: true },
      ],
      refusal: 'message refused',
      tool_calls: [null, { id: 'call', function: { name: 'lookup', arguments: null } }],
      reasoning_details: { opaque: true },
    } }],
    usage: {
      prompt_tokens: 4, completion_tokens: 5, total_tokens: 9,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
    },
  };
}

function anthropicRich(): unknown {
  return {
    id: 'anthropic-rich', stop_reason: 'refusal', stop_details: { code: 'policy' },
    content: [
      null, { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call', name: 'lookup', input: null },
      { type: 'thinking', thinking: 'why', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'refusal', explanation: 'no' }, { type: 'future', value: true },
    ],
    usage: {
      input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 1,
      cache_read_input_tokens: 1, output_tokens_details: { thinking_tokens: 1 },
    },
  };
}

function transportRequest(): ProviderTransportRequest {
  return {
    providerId: 'provider', operation: 'generate', url: 'https://provider.test/v1',
    method: 'POST', headers: {}, body: { hello: true },
  };
}
