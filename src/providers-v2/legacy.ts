import type {
  InputItem,
  JsonObject,
  ModelRef,
  OutputItem,
  Usage,
} from '../core/index.js';
import type {
  ModelApi as LegacyModelApi,
  ModelRequest as LegacyRequest,
  ModelStreamHandle as LegacyStreamHandle,
} from '../types.js';
import type {
  ContentBlock as LegacyContentBlock,
  ContentBlockParam as LegacyContentBlockParam,
  Message as LegacyMessage,
  MessageParam as LegacyMessageParam,
  MessageStreamEvent as LegacyStreamEvent,
  Tool as LegacyTool,
  ToolChoice as LegacyToolChoice,
  Usage as LegacyUsage,
} from '../provider/types.js';

import { BaseModelProvider, isRecord, safeJsonParse } from './adapter-base.js';
import {
  createModelRef,
  mergeModelCapabilities,
  MINIMAL_MODEL_CAPABILITIES,
} from './capabilities.js';
import {
  attachStructuredOutput,
  finishReason,
  itemRecord,
  jsonObject,
  jsonValue,
  rawOutput,
  reasoningOutput,
  refusalOutput,
  textOutput,
  toolCallOutput,
  usageFromProvider,
  zeroUsage,
} from './mapping.js';
import { createModelStream, type ModelStreamMapper } from './stream.js';
import type {
  ModelCallContext,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
  ModelToolPolicy,
  ProviderAdapterOptions,
  ResolvedModel,
} from './types.js';

const LEGACY_CAPABILITIES: ModelCapabilities = mergeModelCapabilities(
  MINIMAL_MODEL_CAPABILITIES,
  {
    input: { image: true, document: true },
    tools: { function: true, parallel: true },
    reasoning: { request: true, opaqueRoundTrip: true },
    streaming: true,
    stopSequences: true,
    providerRawRoundTrip: true,
  },
);

export interface LegacyModelApiProviderOptions extends Omit<ProviderAdapterOptions, 'transport'> {
  readonly modelApi: LegacyModelApi;
}

/** Wraps the existing Anthropic-shaped ModelApi as a Provider v2 implementation. */
export class LegacyModelApiProvider extends BaseModelProvider {
  private readonly modelApi: LegacyModelApi;

  constructor(options: LegacyModelApiProviderOptions) {
    super(options, {
      id: 'legacy',
      baseUrl: 'legacy://model-api',
      capabilities: LEGACY_CAPABILITIES,
    });
    this.modelApi = options.modelApi;
  }

  async generate(
    request: ModelRequest,
    context: ModelCallContext = {},
  ): Promise<ModelResponse> {
    const { model } = await this.prepare(request, context, false);
    const message = await this.modelApi.createMessage(toLegacyRequest(request, model, context));
    return fromLegacyMessage(message, model, request, this.id, this.includeRawResponse);
  }

  stream(request: ModelRequest, context: ModelCallContext = {}): ModelStream {
    const state: LegacyProviderStreamState = { request };
    const mapper: ModelStreamMapper<LegacyProviderStreamState> = {
      state,
      map: (event, current) => this.mapLegacyStreamEvent(event, current),
      finalize: current => {
        if (!current.response) throw new Error('Legacy ModelApi stream ended without a final message.');
        return current.response;
      },
    };
    return createModelStream({
      context,
      mapper,
      start: async streamContext => {
        const { model } = await this.prepare(request, streamContext, true);
        state.model = model;
        const legacyStream = this.modelApi.streamMessage(
          toLegacyRequest(request, model, streamContext),
        );
        return withLegacyFinalMessage(legacyStream);
      },
    });
  }

  private mapLegacyStreamEvent(
    event: unknown,
    state: LegacyProviderStreamState,
  ): readonly ModelStreamEvent[] {
    if (!isRecord(event)) return [];
    if (event.type === '__legacy_final' && isRecord(event.message)) {
      if (!state.model) throw new Error('Legacy stream completed before model resolution.');
      state.response = fromLegacyMessage(
        event.message as unknown as LegacyMessage,
        state.model,
        state.request,
        this.id,
        this.includeRawResponse,
      );
      return [{ type: 'response.completed', response: state.response }];
    }
    if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      const outputIndex = typeof event.index === 'number' ? event.index : undefined;
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
        return [{ type: 'text.delta', delta: event.delta.text, outputIndex }];
      }
      if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
        return [{ type: 'reasoning.delta', delta: event.delta.thinking, outputIndex }];
      }
      if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        return [{
          type: 'tool_call.delta',
          callId: `legacy_tool_${outputIndex ?? 0}`,
          argumentsDelta: event.delta.partial_json,
          outputIndex,
        }];
      }
    }
    if (event.type === 'message_delta' && isRecord(event.usage)) {
      return [{ type: 'usage', usage: legacyUsageToCore(event.usage) }];
    }
    return [{ type: 'provider.event', provider: this.id, event: jsonValue(event) }];
  }
}

interface LegacyProviderStreamState {
  readonly request: ModelRequest;
  model?: ResolvedModel;
  response?: ModelResponse;
}

async function* withLegacyFinalMessage(
  stream: LegacyStreamHandle,
): AsyncGenerator<unknown> {
  for await (const event of stream) yield event;
  yield { type: '__legacy_final', message: await stream.finalMessage() };
}

/**
 * Exposes a Provider v2 through the old ModelApi. This is the direction used by
 * createAgentSdk({ modelApi: new ModelProviderLegacyAdapter(provider) }).
 */
export class ModelProviderLegacyAdapter implements LegacyModelApi {
  constructor(private readonly provider: ModelProvider) {}

  async createMessage(request: LegacyRequest): Promise<LegacyMessage> {
    const response = await this.provider.generate(
      fromLegacyRequest(request, this.provider.id),
      { signal: request.signal },
    );
    return toLegacyMessage(response);
  }

  streamMessage(request: LegacyRequest): LegacyStreamHandle {
    const stream = this.provider.stream(
      fromLegacyRequest(request, this.provider.id),
      { signal: request.signal },
    );
    return new ProviderToLegacyStream(stream);
  }
}

class ProviderToLegacyStream implements LegacyStreamHandle {
  private started = false;
  private readonly finalPromise: Promise<LegacyMessage>;
  private resolveFinal!: (message: LegacyMessage) => void;
  private rejectFinal!: (error: unknown) => void;

  constructor(private readonly stream: ModelStream) {
    this.finalPromise = new Promise<LegacyMessage>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    this.finalPromise.catch(() => {});
  }

  async finalMessage(): Promise<LegacyMessage> {
    if (!this.started) {
      for await (const _event of this) {
        // Drain.
      }
    }
    return this.finalPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<LegacyStreamEvent> {
    if (this.started) throw new Error('Legacy model streams are single-consumer iterables.');
    this.started = true;
    return this.consume()[Symbol.asyncIterator]();
  }

  private async *consume(): AsyncGenerator<LegacyStreamEvent> {
    const blockIndexByKey = new Map<string, number>();
    let nextIndex = 0;
    let messageStarted = false;
    let completed = false;
    try {
      for await (const event of this.stream) {
        if (!messageStarted) {
          messageStarted = true;
          yield {
            type: 'message_start',
            message: {
              id: 'msg_stream',
              type: 'message',
              role: 'assistant',
              model: 'unknown',
              content: [],
              stop_reason: null,
            },
          };
        }
        if (event.type === 'text.delta') {
          const index = ensureLegacyBlock(blockIndexByKey, 'text', () => nextIndex++);
          if (!blockIndexByKey.has('text.started')) {
            blockIndexByKey.set('text.started', index);
            yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
          }
          yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.delta } };
        } else if (event.type === 'reasoning.delta') {
          const index = ensureLegacyBlock(blockIndexByKey, 'reasoning', () => nextIndex++);
          if (!blockIndexByKey.has('reasoning.started')) {
            blockIndexByKey.set('reasoning.started', index);
            yield {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: event.delta ?? '' },
          };
        } else if (event.type === 'tool_call.delta') {
          const key = `tool:${event.callId}`;
          const index = ensureLegacyBlock(blockIndexByKey, key, () => nextIndex++);
          if (!blockIndexByKey.has(`${key}.started`)) {
            blockIndexByKey.set(`${key}.started`, index);
            yield {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: event.callId,
                name: event.name ?? '',
                input: {},
              },
            };
          }
          if (event.argumentsDelta) {
            yield {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: event.argumentsDelta },
            };
          }
        } else if (event.type === 'usage') {
          yield { type: 'message_delta', delta: {}, usage: coreUsageToLegacy(event.usage) };
        } else if (event.type === 'response.completed') {
          for (const [key, index] of blockIndexByKey) {
            if (!key.endsWith('.started')) yield { type: 'content_block_stop', index };
          }
          const message = toLegacyMessage(event.response);
          this.resolveFinal(message);
          yield {
            type: 'message_delta',
            delta: { stop_reason: message.stop_reason },
            usage: message.usage,
          };
          yield { type: 'message_stop' };
          completed = true;
        }
      }
      if (!completed) {
        const response = await this.stream.finalResponse();
        const message = toLegacyMessage(response);
        this.resolveFinal(message);
        yield { type: 'message_stop' };
      }
    } catch (error) {
      this.rejectFinal(error);
      throw error;
    }
  }
}

function ensureLegacyBlock(
  blocks: Map<string, number>,
  key: string,
  create: () => number,
): number {
  const existing = blocks.get(key);
  if (existing !== undefined) return existing;
  const index = create();
  blocks.set(key, index);
  return index;
}

function toLegacyRequest(
  request: ModelRequest,
  model: ResolvedModel,
  context: ModelCallContext,
): LegacyRequest {
  const system = request.input
    .map(itemRecord)
    .filter(item => item.type === 'text' && item.role === 'system' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n\n');
  const messages = request.input
    .filter(item => !(itemRecord(item).type === 'text' && itemRecord(item).role === 'system'))
    .map(toLegacyMessageParam);
  return {
    model: model.modelId,
    messages,
    max_tokens: request.maxOutputTokens ?? 4_096,
    system: system || undefined,
    temperature: request.temperature,
    tools: request.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      strict: tool.strict,
    })),
    tool_choice: toLegacyToolChoice(request.toolPolicy, request.parallelToolCalls),
    metadata: request.metadata,
    stop_sequences: request.stopSequences ? [...request.stopSequences] : undefined,
    effort: request.reasoning?.effort === 'none' || request.reasoning?.effort === 'minimal'
      ? 'low'
      : request.reasoning?.effort === 'xhigh'
        ? 'high'
        : request.reasoning?.effort,
    signal: context.signal,
  };
}

function toLegacyMessageParam(item: InputItem): LegacyMessageParam {
  const record = itemRecord(item);
  const role = record.role === 'assistant' || record.type === 'tool_call' || record.type === 'reasoning'
    ? 'assistant'
    : 'user';
  let block: LegacyContentBlockParam;
  switch (record.type) {
    case 'text':
      block = { type: 'text', text: String(record.text ?? '') };
      break;
    case 'image': {
      const source = isRecord(record.source) ? record.source : {};
      block = {
        type: 'image',
        source: source.kind === 'url'
          ? { type: 'url', url: source.url }
          : source.kind === 'file'
            ? { type: 'file', file_id: source.fileId }
            : {
                type: 'base64',
                media_type: source.mediaType,
                data: source.data,
              },
      };
      break;
    }
    case 'tool_call':
      block = {
        type: 'tool_use',
        id: String(record.id ?? ''),
        name: String(record.name ?? ''),
        input: (record.input ?? {}) as Record<string, unknown>,
      };
      break;
    case 'tool_result':
      block = {
        type: 'tool_result',
        tool_use_id: String(record.callId ?? ''),
        content: typeof record.output === 'string' ? record.output : JSON.stringify(record.output ?? null),
        is_error: record.status === 'error',
      };
      break;
    case 'reasoning':
      block = isRecord(record.opaque)
        ? record.opaque as LegacyContentBlockParam
        : { type: 'thinking', thinking: String(record.summary ?? record.opaque ?? '') };
      break;
    case 'structured':
      block = { type: 'text', text: JSON.stringify(record.value ?? null) };
      break;
    case 'raw':
      block = isRecord(record.value)
        ? record.value as LegacyContentBlockParam
        : { type: 'text', text: String(record.value ?? '') };
      break;
    default:
      block = { type: 'text', text: JSON.stringify(jsonValue(record)) };
  }
  return { role, content: [block] };
}

function fromLegacyMessage(
  message: LegacyMessage,
  model: ResolvedModel,
  request: ModelRequest,
  providerId: string,
  includeRawResponse: boolean,
): ModelResponse {
  const output: OutputItem[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      output.push(textOutput(block.text));
    } else if (block.type === 'tool_use') {
      output.push(toolCallOutput(
        String(block.id ?? ''),
        String(block.name ?? ''),
        block.input ?? {},
      ));
    } else if (block.type === 'thinking') {
      output.push(reasoningOutput(
        providerId,
        block,
        typeof block.thinking === 'string' ? block.thinking : undefined,
      ));
    } else if (block.type === 'refusal') {
      output.push(refusalOutput(String((block as Record<string, unknown>).explanation ?? 'Refused.'), block));
    } else {
      output.push(rawOutput(providerId, block));
    }
  }
  const parsedStructuredOutput = attachStructuredOutput(request, output);
  return {
    id: message.id,
    model,
    output,
    finishReason: finishReason(message.stop_reason),
    usage: legacyUsageToCore(message.usage),
    structuredOutput: parsedStructuredOutput,
    ...(includeRawResponse ? { rawResponse: jsonValue(message) } : {}),
  };
}

function fromLegacyRequest(request: LegacyRequest, providerId: string): ModelRequest {
  const input: InputItem[] = [];
  if (request.system) input.push({ type: 'text', role: 'system', text: request.system });
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      input.push({ type: 'text', role: message.role, text: message.content });
      continue;
    }
    for (const block of message.content) {
      const record = block as Record<string, unknown>;
      if (record.type === 'text') {
        input.push({ type: 'text', role: message.role, text: String(record.text ?? '') });
      } else if (record.type === 'image' && isRecord(record.source)) {
        const source = record.source;
        const coreSource = source.type === 'url'
          ? { kind: 'url' as const, url: String(source.url ?? '') }
          : source.type === 'file'
            ? { kind: 'file' as const, fileId: String(source.file_id ?? '') }
            : {
                kind: 'base64' as const,
                mediaType: String(source.media_type ?? 'image/png'),
                data: String(source.data ?? ''),
              };
        input.push({ type: 'image', role: message.role, source: coreSource });
      } else if (record.type === 'tool_use') {
        input.push({
          type: 'tool_call',
          id: String(record.id ?? ''),
          name: String(record.name ?? ''),
          input: jsonObject(record.input),
        });
      } else if (record.type === 'tool_result') {
        input.push({
          type: 'tool_result',
          callId: String(record.tool_use_id ?? ''),
          status: record.is_error === true ? 'error' : 'success',
          output: jsonValue(record.content ?? ''),
        });
      } else if (record.type === 'thinking') {
        input.push({
          type: 'reasoning',
          provider: providerId,
          summary: typeof record.thinking === 'string' ? record.thinking : undefined,
          opaque: jsonValue(record),
        });
      } else {
        input.push({ type: 'raw', provider: providerId, value: jsonValue(record) });
      }
    }
  }
  return {
    model: createModelRef(providerId, request.model),
    input,
    tools: request.tools?.map(fromLegacyTool),
    toolPolicy: fromLegacyToolChoice(request.tool_choice),
    parallelToolCalls: parallelFromLegacyToolChoice(request.tool_choice),
    maxOutputTokens: request.max_tokens,
    temperature: request.temperature,
    stopSequences: request.stop_sequences,
    metadata: request.metadata ? jsonObject(request.metadata) : undefined,
    reasoning: request.effort ? { effort: request.effort } : undefined,
  };
}

function fromLegacyTool(tool: LegacyTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonObject(tool.input_schema),
    strict: tool.strict,
  };
}

function toLegacyMessage(response: ModelResponse): LegacyMessage {
  const content: LegacyContentBlock[] = [];
  const hasTextOutput = response.output.some(item => item.type === 'text');
  for (const item of response.output) {
    const record = itemRecord(item);
    if (record.type === 'text') {
      content.push({ type: 'text', text: String(record.text ?? '') });
    } else if (record.type === 'tool_call') {
      content.push({
        type: 'tool_use',
        id: String(record.id ?? ''),
        name: String(record.name ?? ''),
        input: (record.input ?? {}) as Record<string, unknown>,
      });
    } else if (record.type === 'reasoning') {
      content.push(isRecord(record.opaque)
        ? record.opaque as LegacyContentBlock
        : { type: 'thinking', thinking: String(record.summary ?? record.opaque ?? '') });
    } else if (record.type === 'structured') {
      if (!hasTextOutput) {
        content.push({ type: 'text', text: JSON.stringify(record.value ?? null) });
      }
    } else if (record.type === 'refusal') {
      content.push({ type: 'text', text: String(record.message ?? 'Refused.') });
    } else if (record.type === 'raw' && isRecord(record.value)) {
      content.push(record.value as LegacyContentBlock);
    }
  }
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model.modelId,
    content,
    stop_reason: toLegacyStopReason(response.finishReason),
    stop_sequence: null,
    usage: coreUsageToLegacy(response.usage),
  };
}

function legacyUsageToCore(usage: LegacyUsage | undefined): Usage {
  const base = usageFromProvider(usage, {
    input: ['input_tokens'],
    output: ['output_tokens'],
    cachedInput: ['cache_read_input_tokens'],
    cacheWrite: ['cache_creation_input_tokens'],
    reasoning: ['output_tokens_details.thinking_tokens'],
  });
  const inputTokens = base.inputTokens + base.cacheReadTokens + base.cacheWriteTokens;
  return { ...base, inputTokens, totalTokens: inputTokens + base.outputTokens };
}

function coreUsageToLegacy(usage: Usage): LegacyUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

function toLegacyToolChoice(
  policy: ModelToolPolicy | undefined,
  parallel: boolean | undefined,
): LegacyToolChoice | undefined {
  if (!policy && parallel === undefined) return undefined;
  const disable = parallel === undefined ? undefined : !parallel;
  if (!policy || policy === 'auto') return { type: 'auto', disable_parallel_tool_use: disable };
  if (policy === 'required') return { type: 'any', disable_parallel_tool_use: disable };
  if (policy === 'none') return { type: 'none', disable_parallel_tool_use: disable };
  return { type: 'tool', name: policy.name, disable_parallel_tool_use: disable };
}

function fromLegacyToolChoice(choice: LegacyToolChoice | undefined): ModelToolPolicy | undefined {
  if (!choice) return undefined;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'tool', name: choice.name };
  }
  if (choice.type === 'none') return 'none';
  return 'auto';
}

function parallelFromLegacyToolChoice(choice: LegacyToolChoice | undefined): boolean | undefined {
  if (!choice || !('disable_parallel_tool_use' in choice)) return undefined;
  return choice.disable_parallel_tool_use === undefined
    ? undefined
    : !choice.disable_parallel_tool_use;
}

function toLegacyStopReason(reason: ModelResponse['finishReason']): LegacyMessage['stop_reason'] {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return reason === 'stop' ? 'end_turn' : reason;
}
