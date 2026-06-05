import { describe, expect, it } from 'vitest';

import { ActoviqProviderApiError } from '../src/errors.js';
import OpenaiProviderClient from '../src/provider/openai-client.js';

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

