import { describe, expect, it } from 'vitest';

import { ActoviqProviderApiError } from '../src/errors.js';
import ActoviqProviderClient, { normalizeProviderUsage } from '../src/provider/client.js';
import OpenaiProviderClient from '../src/provider/openai-client.js';
import { OpenaiModelApi } from '../src/provider/openai-model-api.js';
import { ActoviqModelApi } from '../src/runtime/actoviqModelApi.js';

function makeCompletionResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok',
        },
        finish_reason: 'stop',
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('OpenaiProviderClient retry behavior', () => {
  it('normalizes exhausted socket termination retries as provider transport errors', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new TypeError('terminated', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      });
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 1,
      fetch: fetchImpl,
    });

    await expect(client.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({
      code: 'ACTOVIQ_PROVIDER_API_ERROR',
      status: 0,
      errorType: 'transport_error',
    });
    expect(calls).toBe(2);
  });

  it('does not retry non-retryable provider HTTP errors', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'bad request',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 3,
      fetch: fetchImpl,
    });

    await expect(client.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toBeInstanceOf(ActoviqProviderApiError);
    expect(calls).toBe(1);
  });

  it('still retries transient errors when a later attempt succeeds', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed');
      }
      return makeCompletionResponse();
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 1,
      fetch: fetchImpl,
    });

    const result = await client.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.choices[0]?.message.content).toBe('ok');
    expect(calls).toBe(2);
  });

  it('stops retry backoff immediately when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    let markFirstCall!: () => void;
    const firstCall = new Promise<void>((resolve) => { markFirstCall = resolve; });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      markFirstCall();
      return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '30',
        },
      });
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 3,
      fetch: fetchImpl,
    });

    const request = client.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, controller.signal);
    await firstCall;
    controller.abort(new Error('cancel retry backoff'));

    await expect(request).rejects.toThrow('cancel retry backoff');
    expect(calls).toBe(1);
  });
});

describe('provider stream completion validation', () => {
  it('rejects an OpenAI stream that closes before a terminal marker', async () => {
    const chunk = {
      id: 'chatcmpl_partial',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }],
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      fetch: async () => makeSseResponse(`data: ${JSON.stringify(chunk)}\n\n`),
    });
    const stream = client.chat.completions.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const consume = async () => {
      for await (const _chunk of stream) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('ended prematurely');
    await expect(stream.finalMessage()).rejects.toThrow('ended prematurely');
  });

  it('accepts a conclusive OpenAI finish_reason without a trailing DONE marker', async () => {
    const chunk = {
      id: 'chatcmpl_complete',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }],
    };
    const client = new OpenaiProviderClient({
      apiKey: 'test-key',
      fetch: async () => makeSseResponse(`data: ${JSON.stringify(chunk)}\n\n`),
    });

    const completion = await client.chat.completions.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }).finalMessage();

    expect(completion.choices[0]?.message.content).toBe('complete');
    expect(completion.choices[0]?.finish_reason).toBe('stop');
  });

  it('rejects an Anthropic stream that closes before a terminal state', async () => {
    const start = {
      type: 'message_start',
      message: {
        id: 'msg_partial',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    const client = new ActoviqProviderClient({
      apiKey: 'test-key',
      fetch: async () => makeSseResponse(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`),
    });
    const stream = client.messages.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    });

    const consume = async () => {
      for await (const _event of stream) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('ended prematurely');
    await expect(stream.finalMessage()).rejects.toThrow('ended prematurely');
  });
});

describe('ActoviqProviderClient retry behavior', () => {
  it('stops retry backoff immediately when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    let markFirstCall!: () => void;
    const firstCall = new Promise<void>((resolve) => { markFirstCall = resolve; });
    const client = new ActoviqProviderClient({
      apiKey: 'test-key',
      maxRetries: 3,
      fetch: async () => {
        calls += 1;
        markFirstCall();
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'retry-after': '30',
          },
        });
      },
    });

    const request = client.messages.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    }, { signal: controller.signal });
    await firstCall;
    controller.abort(new Error('cancel retry backoff'));

    await expect(request).rejects.toThrow('cancel retry backoff');
    expect(calls).toBe(1);
  });
});

describe('reasoning effort request mapping', () => {
  it('maps Clean SDK effort to Anthropic output_config and beta headers', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const api = new ActoviqModelApi(
      new ActoviqProviderClient({
        apiKey: 'test-key',
        baseURL: 'https://example.test',
        fetch: fetchImpl,
      }),
    );

    await api.createMessage({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      effort: 'max',
    });

    expect(body?.output_config).toEqual({ effort: 'max' });
    expect(headers?.get('anthropic-beta')).toContain('effort-2025-11-24');
  });

  it('adds a system prompt cache breakpoint when request caching is active', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const api = new ActoviqModelApi(
      new ActoviqProviderClient({
        apiKey: 'test-key',
        baseURL: 'https://example.test',
        fetch: fetchImpl,
      }),
    );

    await api.createMessage({
      model: 'test-model',
      system: 'stable system prompt',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
      max_tokens: 100,
    });

    const system = body?.system as Array<Record<string, unknown>>;
    expect(system[0]).toMatchObject({
      type: 'text',
      text: 'stable system prompt',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('maps max effort to the highest broadly compatible OpenAI effort', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return makeCompletionResponse();
    };
    const api = new OpenaiModelApi(
      new OpenaiProviderClient({
        apiKey: 'test-key',
        baseURL: 'https://example.test/v1',
        fetch: fetchImpl,
      }),
    );

    await api.createMessage({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      effort: 'max',
    });

    expect(body?.reasoning_effort).toBe('high');
  });
});

describe('normalizeProviderUsage', () => {
  it('maps DeepSeek prompt_cache_hit_tokens onto cache_read_input_tokens', () => {
    const usage = normalizeProviderUsage({
      input_tokens: 1000,
      output_tokens: 20,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
    });

    expect(usage.cache_read_input_tokens).toBe(900);
    expect(usage.prompt_cache_hit_tokens).toBe(900);
    expect(usage.prompt_cache_miss_tokens).toBe(100);
    expect(usage.input_tokens).toBe(1000);
  });

  it('does not overwrite an explicit Anthropic cache_read_input_tokens value', () => {
    const usage = normalizeProviderUsage({
      input_tokens: 50,
      cache_read_input_tokens: 40,
      prompt_cache_hit_tokens: 99,
    });

    expect(usage.cache_read_input_tokens).toBe(40);
  });

  it('maps DeepSeek cache fields through createMessage responses', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'msg_ds',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-pro',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 500,
            output_tokens: 10,
            prompt_cache_hit_tokens: 450,
            prompt_cache_miss_tokens: 50,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const client = new ActoviqProviderClient({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/anthropic',
      fetch: fetchImpl,
    });

    const message = await client.messages.create({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
    });

    expect(message.usage?.cache_read_input_tokens).toBe(450);
    expect(message.usage?.prompt_cache_miss_tokens).toBe(50);
  });
});

