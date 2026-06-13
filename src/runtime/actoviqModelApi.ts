import ActoviqProviderClient from '../provider/client.js';

import type { ModelApi, ModelRequest, ModelStreamHandle, ResolvedRuntimeConfig } from '../types.js';

export class ActoviqModelApi implements ModelApi {
  constructor(private readonly client: ActoviqProviderClient) {}

  async createMessage(request: ModelRequest) {
    const { signal, effort, ...body } = request;
    return this.client.messages.create(
      {
        ...body,
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
        ...body,
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



