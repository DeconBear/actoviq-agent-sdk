import type { JsonObject, ModelRef } from '../core/index.js';

import {
  assertRequestCapabilities,
  modelRefParts,
  resolveModelCapabilities,
} from './capabilities.js';
import { FetchProviderTransport } from './transport.js';
import type {
  ModelCallContext,
  ModelCapabilities,
  ModelCapabilitiesSource,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ProviderAdapterOptions,
  ProviderTransport,
  ProviderTransportRequest,
  ResolvedModel,
} from './types.js';

export abstract class BaseModelProvider implements ModelProvider {
  readonly id: string;
  protected readonly baseUrl: string;
  protected readonly transport: ProviderTransport;
  protected readonly includeRawResponse: boolean;
  protected readonly preserveProviderItems: boolean;
  protected readonly apiKey?: string;
  protected readonly authToken?: string;
  private readonly capabilitySource?: ModelCapabilitiesSource;

  protected constructor(
    options: ProviderAdapterOptions,
    defaults: {
      readonly id: string;
      readonly baseUrl: string;
      readonly capabilities: ModelCapabilities;
    },
  ) {
    this.id = options.id ?? defaults.id;
    this.baseUrl = (options.baseUrl ?? defaults.baseUrl).replace(/\/+$/u, '');
    this.transport = options.transport ?? new FetchProviderTransport();
    this.capabilitySource = options.capabilities;
    this.defaultCapabilities = defaults.capabilities;
    this.includeRawResponse = options.includeRawResponse ?? false;
    this.preserveProviderItems = options.preserveProviderItems ?? true;
    this.apiKey = options.apiKey;
    this.authToken = options.authToken;
  }

  private readonly defaultCapabilities: ModelCapabilities;

  abstract generate(
    request: ModelRequest,
    context: ModelCallContext,
  ): Promise<ModelResponse>;

  abstract stream(request: ModelRequest, context: ModelCallContext): ModelStream;

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const { providerId, modelId } = modelRefParts(ref, this.id);
    if (providerId !== this.id) {
      throw new TypeError(
        `Provider ${this.id} cannot resolve model owned by provider ${providerId}.`,
      );
    }
    return Object.freeze({ providerId: this.id, modelId, ref });
  }

  async capabilities(model: ResolvedModel): Promise<ModelCapabilities> {
    if (model.providerId !== this.id) {
      throw new TypeError(
        `Resolved model belongs to ${model.providerId}, not provider ${this.id}.`,
      );
    }
    return resolveModelCapabilities(this.capabilitySource, this.defaultCapabilities, model);
  }

  protected async prepare(
    request: ModelRequest,
    context: ModelCallContext,
    streaming: boolean,
  ): Promise<{ model: ResolvedModel; capabilities: ModelCapabilities }> {
    throwIfCallUnavailable(context);
    const model = isResolvedForProvider(request.model)
      ? request.model
      : await this.resolve(request.model);
    if (model.providerId !== this.id) {
      throw new TypeError(
        `Request model belongs to ${model.providerId}, not provider ${this.id}.`,
      );
    }
    const capabilities = await this.capabilities(model);
    assertRequestCapabilities(this.id, model, capabilities, request, { streaming });
    return { model, capabilities };
  }

  protected createTransportRequest(
    operation: ProviderTransportRequest['operation'],
    endpoint: string,
    body: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>>,
  ): ProviderTransportRequest {
    return {
      providerId: this.id,
      operation,
      url: joinEndpoint(this.baseUrl, endpoint),
      method: 'POST',
      headers,
      body,
    };
  }

  protected providerOptions(request: ModelRequest): Readonly<JsonObject> {
    const options = request.providerOptions?.[this.id];
    return isJsonObject(options) ? options : {};
  }
}

export function compactObject(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

export function joinEndpoint(baseUrl: string, endpoint: string): string {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (baseUrl.toLowerCase().endsWith(normalizedEndpoint.toLowerCase())) return baseUrl;
  return `${baseUrl}${normalizedEndpoint}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function stringifyToolValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

function isResolvedForProvider(value: ModelRef | ResolvedModel): value is ResolvedModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { providerId?: unknown }).providerId === 'string' &&
    typeof (value as { modelId?: unknown }).modelId === 'string' &&
    'ref' in value
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function throwIfCallUnavailable(context: ModelCallContext): void {
  if (context.signal?.aborted) {
    throw context.signal.reason ?? abortError('Model call aborted.');
  }
  if (context.deadline !== undefined && context.deadline <= Date.now()) {
    throw abortError('Model call deadline exceeded.');
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
