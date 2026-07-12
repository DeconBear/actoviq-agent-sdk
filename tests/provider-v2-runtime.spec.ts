import { describe, expect, it } from 'vitest';

import type { AgentSpec } from '../src/core/index.js';
import {
  ModelRegistry,
  OpenAIResponsesProvider,
  type ProviderTransport,
  type ProviderTransportRequest,
} from '../src/providers-v2/index.js';
import { AgentRuntime } from '../src/runtime-v2/index.js';

describe('Provider v2 -> AgentRuntime end-to-end', () => {
  it('runs a minimal text agent through registry, capability preflight, adapter, and runtime', async () => {
    const transport = new RuntimeTransport();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([
        new OpenAIResponsesProvider({ transport }),
      ]),
      defaultModel: { provider: 'openai-responses', model: 'test-model' },
    });
    const agent: AgentSpec = {
      id: 'text-agent',
      name: 'Text agent',
      instructions: 'Answer briefly.',
    };

    try {
      const result = await runtime.run(agent, 'hello');
      expect(result.output).toBe('runtime ok');
      expect(result.usage).toMatchObject({
        requests: 1,
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
      expect(transport.calls).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('returns typed structured output through the same runtime path', async () => {
    const transport = new RuntimeTransport();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([
        new OpenAIResponsesProvider({ transport }),
      ]),
      defaultModel: 'test-model',
    });
    const agent: AgentSpec<unknown, { answer: string }> = {
      id: 'structured-agent',
      name: 'Structured agent',
      instructions: 'Return JSON.',
      output: {
        name: 'answer',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        parse: value => value as { answer: string },
      },
    };

    try {
      const result = await runtime.run(agent, 'hello');
      expect(result.output).toEqual({ answer: 'runtime ok' });
      expect(JSON.stringify(transport.calls[0]?.body)).toContain('json_schema');
    } finally {
      await runtime.close();
    }
  });
});

class RuntimeTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];

  async request(request: ProviderTransportRequest): Promise<unknown> {
    this.calls.push(request);
    const structured = typeof request.body.text === 'object' && request.body.text !== null;
    return {
      id: 'resp_runtime',
      object: 'response',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: structured ? '{"answer":"runtime ok"}' : 'runtime ok',
        }],
      }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
  }

  async *stream(_request: ProviderTransportRequest): AsyncGenerator<unknown> {
    throw new Error('Streaming is not used in this acceptance path.');
  }
}
