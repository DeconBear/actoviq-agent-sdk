import { describe, expect, it } from 'vitest';

import { ActoviqProviderApiError } from '../src/errors.js';
import ActoviqProviderClient from '../src/provider/client.js';
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

