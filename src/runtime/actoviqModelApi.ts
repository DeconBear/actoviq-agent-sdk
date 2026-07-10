import ActoviqProviderClient from '../provider/client.js';

import type { ModelApi, ModelRequest, ModelStreamHandle, ResolvedRuntimeConfig } from '../types.js';

export class ActoviqModelApi implements ModelApi {
  constructor(private readonly client: ActoviqProviderClient) {}

  async createMessage(request: ModelRequest) {
    const { signal, effort, ...body } = request;
    return this.client.messages.create(
      {
        ...withCachedSystemPrompt(body),
        ...(effort ? { output_config: { effort } } : {}),
      },
      signal || effort
        ? {
            signal,
            ...(effort ? { betas: ['effort-2025-11-24'] } : {}),
          }
        : undefined,
    );
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    const { signal, effort, ...body } = request;
    return this.client.messages.stream(
      {
        ...withCachedSystemPrompt(body),
        ...(effort ? { output_config: { effort } } : {}),
      },
      signal || effort
        ? {
            signal,
            ...(effort ? { betas: ['effort-2025-11-24'] } : {}),
          }
        : undefined,
    );
  }
}

function withCachedSystemPrompt(
  body: Omit<ModelRequest, 'signal' | 'effort'>,
): Omit<ModelRequest, 'signal' | 'effort' | 'system'> & { system?: string | unknown[] } {
  if (!body.system || !requestHasPromptCacheBreakpoint(body)) {
    return body;
  }
  return {
    ...body,
    system: [
      { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } },
    ],
  };
}

function requestHasPromptCacheBreakpoint(
  body: Omit<ModelRequest, 'signal' | 'effort'>,
): boolean {
  return JSON.stringify({ tools: body.tools, messages: body.messages }).includes('cache_control');
}

export function createActoviqModelApi(config: ResolvedRuntimeConfig): ModelApi {
  const client = new ActoviqProviderClient({
    apiKey: config.apiKey ?? null,
    authToken: config.authToken ?? null,
    baseURL: config.baseURL ?? null,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  return new ActoviqModelApi(client);
}



