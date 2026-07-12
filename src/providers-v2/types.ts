import type {
  InputItem,
  JsonObject,
  JsonValue,
  ModelRef,
  OutputItem,
  Usage,
} from '../core/index.js';

/** A provider/model pair after registry resolution. */
export interface ResolvedModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly ref: ModelRef;
  readonly metadata?: Readonly<JsonObject>;
}
export interface ModelCapabilities {
  readonly input: {
    readonly text: boolean;
    readonly image: boolean;
    readonly audio: boolean;
    readonly document: boolean;
    readonly artifact: boolean;
  };
  readonly output: {
    readonly text: boolean;
    readonly image: boolean;
    readonly audio: boolean;
    readonly structured: boolean;
  };
  readonly tools: {
    readonly function: boolean;
    readonly parallel: boolean;
    readonly hosted: boolean;
  };
  readonly reasoning: {
    readonly request: boolean;
    readonly opaqueRoundTrip: boolean;
  };
  readonly streaming: boolean;
  readonly promptCaching: boolean;
  readonly stopSequences: boolean;
  readonly providerRawRoundTrip: boolean;
}

export type ModelCapability =
  | 'input.text'
  | 'input.image'
  | 'input.audio'
  | 'input.document'
  | 'input.artifact'
  | 'output.text'
  | 'output.image'
  | 'output.audio'
  | 'output.structured'
  | 'tools.function'
  | 'tools.parallel'
  | 'tools.hosted'
  | 'reasoning.request'
  | 'reasoning.opaqueRoundTrip'
  | 'streaming'
  | 'promptCaching'
  | 'stopSequences'
  | 'providerRawRoundTrip';

export interface ModelToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<JsonObject>;
  readonly strict?: boolean;
  readonly hosted?: boolean;
  readonly providerOptions?: Readonly<JsonObject>;
}

export type ModelToolPolicy =
  | 'none'
  | 'auto'
  | 'required'
  | { readonly type: 'tool'; readonly name: string };

export interface ModelOutputSchema {
  readonly name: string;
  readonly schema: Readonly<JsonObject>;
  readonly description?: string;
  readonly strict?: boolean;
}

export interface ModelReasoningRequest {
  readonly effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly summary?: 'none' | 'auto' | 'concise' | 'detailed';
  readonly budgetTokens?: number;
}

export interface ModelRequest {
  readonly model: ModelRef | ResolvedModel;
  readonly input: readonly InputItem[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly toolPolicy?: ModelToolPolicy;
  readonly parallelToolCalls?: boolean;
  readonly outputSchema?: ModelOutputSchema;
  readonly outputModalities?: readonly ('text' | 'image' | 'audio')[];
  readonly reasoning?: ModelReasoningRequest;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly promptCacheKey?: string;
  readonly metadata?: Readonly<JsonObject>;
  /** Explicit escape hatch. Each adapter namespaces and validates this value. */
  readonly providerOptions?: Readonly<JsonObject>;
}

export interface ModelCallContext {
  readonly runId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
  /** Absolute Unix epoch deadline in milliseconds. */
  readonly deadline?: number;
  readonly metadata?: Readonly<JsonObject>;
}

export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'refusal'
  | 'cancelled'
  | 'error'
  | 'unknown';

export interface ModelResponse {
  readonly id: string;
  readonly model: ResolvedModel;
  readonly output: readonly OutputItem[];
  readonly finishReason: ModelFinishReason;
  readonly usage: Usage;
  /** Parsed JSON when outputSchema was requested and the provider returned valid JSON. */
  readonly structuredOutput?: JsonValue;
  /** Entire provider response; opt-in because it may contain sensitive data. */
  readonly rawResponse?: JsonValue;
}

export type ModelStreamEvent =
  | { readonly type: 'text.delta'; readonly delta: string; readonly outputIndex?: number }
  | {
      readonly type: 'tool_call.delta';
      readonly callId: string;
      readonly name?: string;
      readonly argumentsDelta: string;
      readonly outputIndex?: number;
    }
  | {
      readonly type: 'reasoning.delta';
      readonly delta?: string;
      readonly opaque?: JsonValue;
      readonly outputIndex?: number;
    }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'provider.event'; readonly provider: string; readonly event: JsonValue }
  | { readonly type: 'response.completed'; readonly response: ModelResponse };

export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
  finalResponse(): Promise<ModelResponse>;
  cancel(reason?: unknown): void;
}

export interface ModelProvider {
  readonly id: string;
  resolve(model: ModelRef): Promise<ResolvedModel>;
  capabilities(model: ResolvedModel): Promise<ModelCapabilities>;
  generate(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse>;
  stream(request: ModelRequest, context: ModelCallContext): ModelStream;
}

export interface ProviderTransportRequest {
  readonly providerId: string;
  readonly operation: 'generate' | 'stream';
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderTransport {
  request(request: ProviderTransportRequest, context: ModelCallContext): Promise<unknown>;
  stream(
    request: ProviderTransportRequest,
    context: ModelCallContext,
  ): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

export type ModelCapabilitiesSource =
  | ModelCapabilities
  | Readonly<Record<string, ModelCapabilities>>
  | ((model: ResolvedModel) => ModelCapabilities | Promise<ModelCapabilities>);

export interface ProviderAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly transport?: ProviderTransport;
  readonly capabilities?: ModelCapabilitiesSource;
  /** Keep the full response only when the caller accepts its data-retention implications. */
  readonly includeRawResponse?: boolean;
  /** Preserve unknown provider output items as canonical raw items. Defaults to true. */
  readonly preserveProviderItems?: boolean;
}

export function isResolvedModel(value: ModelRef | ResolvedModel): value is ResolvedModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { providerId?: unknown }).providerId === 'string' &&
    typeof (value as { modelId?: unknown }).modelId === 'string' &&
    'ref' in value
  );
}
