import { describe, expect, it, vi } from 'vitest';

import {
  FetchProviderTransport,
  ModelRegistry,
  ModelRegistryError,
  OpenAIResponsesProvider,
  type ProviderTransport,
  type ProviderTransportRequest,
} from '../src/providers-v2/index.js';

describe('ModelRegistry', () => {
  it('registers, resolves, prepares, routes, and unregisters providers', async () => {
    const transport = new StaticTransport();
    const provider = new OpenAIResponsesProvider({ transport });
    const registry = new ModelRegistry([provider]);
    const request = {
      model: { provider: 'openai-responses', model: 'test-model' } as const,
      input: [{ type: 'text', role: 'user', text: 'hello' } as const],
    };

    expect(registry.providerFor(request.model)).toBe(provider);
    const prepared = await registry.prepare(request);
    expect(prepared.model).toMatchObject({
      providerId: 'openai-responses',
      modelId: 'test-model',
    });
    expect(prepared.request.model).toBe(prepared.model);

    const response = await registry.generate(request);
    expect(response.output[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(transport.calls).toHaveLength(1);

    const shorthand = await registry.resolve('test-model');
    expect(shorthand).toMatchObject({
      providerId: 'openai-responses',
      modelId: 'test-model',
    });

    expect(registry.unregister('openai-responses')).toBe(true);
    expect(() => registry.providerFor(request.model)).toThrow(ModelRegistryError);
  });

  it('rejects duplicate and unknown provider ids with deterministic diagnostics', () => {
    const provider = new OpenAIResponsesProvider({ transport: new StaticTransport() });
    const registry = new ModelRegistry([provider]);

    expect(() => registry.register(provider)).toThrow(/already registered/);
    expect(() => registry.get('missing')).toThrow(/Registered providers: openai-responses/);
    expect(() => registry.get('missing')).toThrow(ModelRegistryError);
  });
});

describe('FetchProviderTransport', () => {
  it('retries transient request establishment and returns parsed JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const sleep = vi.fn(async () => {});
    const transport = new FetchProviderTransport({
      fetch: fetchImpl,
      maxRetries: 1,
      retryBaseDelayMs: 0,
      sleep,
      random: () => 0,
    });

    await expect(transport.request(transportRequest(), {})).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable provider response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'invalid' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const transport = new FetchProviderTransport({
      fetch: fetchImpl,
      maxRetries: 3,
      sleep: async () => {},
    });

    await expect(transport.request(transportRequest(), {})).rejects.toMatchObject({
      code: 'PROVIDER_TRANSPORT_ERROR',
      status: 400,
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parses SSE events and never retries after stream data is visible', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      [
        'event: response.output_text.delta',
        'data: {"delta":"hello"}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const transport = new FetchProviderTransport({ fetch: fetchImpl });
    const events: unknown[] = [];

    for await (const event of transport.stream(transportRequest('stream'), {})) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'hello' },
      { type: 'done' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted call before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = new FetchProviderTransport({ fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error('cancelled before fetch'));

    await expect(transport.request(transportRequest(), {
      signal: controller.signal,
    })).rejects.toThrow('cancelled before fetch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an expired deadline before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = new FetchProviderTransport({ fetch: fetchImpl });

    await expect(transport.request(transportRequest(), {
      deadline: Date.now() - 1,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

class StaticTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];

  async request(request: ProviderTransportRequest): Promise<unknown> {
    this.calls.push(request);
    return {
      id: 'resp_registry',
      object: 'response',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
  }

  async *stream(request: ProviderTransportRequest): AsyncGenerator<unknown> {
    this.calls.push(request);
    yield { type: 'response.completed', response: await this.request(request) };
  }
}

function transportRequest(operation: 'generate' | 'stream' = 'generate'): ProviderTransportRequest {
  return {
    providerId: 'test',
    operation,
    url: 'https://provider.example/v1/responses',
    method: 'POST',
    headers: {},
    body: { model: 'test-model', input: 'hello' },
  };
}
