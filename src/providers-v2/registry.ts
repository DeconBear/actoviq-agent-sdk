import type { ModelRef } from '../core/index.js';

import { assertRequestCapabilities, modelRefParts } from './capabilities.js';
import type {
  ModelCallContext,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ResolvedModel,
} from './types.js';

export class ModelRegistryError extends Error {
  readonly code = 'MODEL_REGISTRY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

export interface PreparedModelCall {
  readonly provider: ModelProvider;
  readonly model: ResolvedModel;
  readonly capabilities: ModelCapabilities;
  readonly request: ModelRequest & { readonly model: ResolvedModel };
}

export interface ModelRegistryOptions {
  readonly defaultProviderId?: string;
}

export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly configuredDefaultProviderId?: string;

  constructor(
    providers: readonly ModelProvider[] = [],
    options: ModelRegistryOptions = {},
  ) {
    this.configuredDefaultProviderId = options.defaultProviderId;
    for (const provider of providers) this.register(provider);
    if (
      this.configuredDefaultProviderId &&
      this.providers.size > 0 &&
      !this.providers.has(this.configuredDefaultProviderId)
    ) {
      throw new ModelRegistryError(
        `Default model provider ${this.configuredDefaultProviderId} is not registered.`,
      );
    }
  }

  register(provider: ModelProvider, options: { readonly replace?: boolean } = {}): this {
    if (!provider.id) {
      throw new ModelRegistryError('A model provider must have a non-empty id.');
    }
    if (this.providers.has(provider.id) && !options.replace) {
      throw new ModelRegistryError(`Model provider ${provider.id} is already registered.`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  get(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ModelRegistryError(
        `Unknown model provider ${providerId}. Registered providers: ${
          [...this.providers.keys()].sort().join(', ') || '(none)'
        }.`,
      );
    }
    return provider;
  }

  providerFor(model: ModelRef | ResolvedModel): ModelProvider {
    const providerId = isResolved(model)
      ? model.providerId
      : modelRefParts(model, this.defaultProviderId()).providerId;
    return this.get(providerId);
  }

  list(): readonly ModelProvider[] {
    return [...this.providers.values()];
  }

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const { providerId, modelId } = modelRefParts(ref, this.defaultProviderId());
    return this.get(providerId).resolve(
      typeof ref === 'string' ? { provider: providerId, model: modelId } : ref,
    );
  }

  async capabilities(model: ModelRef | ResolvedModel): Promise<ModelCapabilities> {
    const resolved = isResolved(model) ? model : await this.resolve(model);
    return this.get(resolved.providerId).capabilities(resolved);
  }

  async prepare(
    request: ModelRequest,
    options: { readonly streaming?: boolean } = {},
  ): Promise<PreparedModelCall> {
    const model = isResolved(request.model)
      ? request.model
      : await this.resolve(request.model);
    const provider = this.get(model.providerId);
    const capabilities = await provider.capabilities(model);
    assertRequestCapabilities(provider.id, model, capabilities, request, options);
    return {
      provider,
      model,
      capabilities,
      request: { ...request, model },
    };
  }

  async generate(
    request: ModelRequest,
    context: ModelCallContext = {},
  ): Promise<ModelResponse> {
    const prepared = await this.prepare(request);
    return prepared.provider.generate(prepared.request, context);
  }

  stream(request: ModelRequest, context: ModelCallContext = {}): ModelStream {
    const providerId = isResolved(request.model)
      ? request.model.providerId
      : modelRefParts(request.model, this.defaultProviderId()).providerId;
    return this.get(providerId).stream(request, context);
  }

  private defaultProviderId(): string | undefined {
    if (this.configuredDefaultProviderId) return this.configuredDefaultProviderId;
    if (this.providers.size === 1) return this.providers.keys().next().value;
    return undefined;
  }
}

function isResolved(value: ModelRef | ResolvedModel): value is ResolvedModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { providerId?: unknown }).providerId === 'string' &&
    typeof (value as { modelId?: unknown }).modelId === 'string' &&
    'ref' in value
  );
}
