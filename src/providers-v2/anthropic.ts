import type { InputItem, OutputItem, Usage } from '../core/index.js';

import {
  BaseModelProvider,
  compactObject,
  isRecord,
  safeJsonParse,
  stringifyToolValue,
} from './adapter-base.js';
import { ANTHROPIC_MESSAGES_CAPABILITIES } from './capabilities.js';
import {
  finishReason,
  imageSourceParts,
  itemRecord,
  jsonValue,
  providerRawInput,
  rawOutput,
  reasoningOutput,
  refusalOutput,
  attachStructuredOutput,
  textOutput,
  toolCallOutput,
  usageFromProvider,
  zeroUsage,
} from './mapping.js';
import { createModelStream, type ModelStreamMapper } from './stream.js';
import type {
  ModelCallContext,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
  ProviderAdapterOptions,
  ResolvedModel,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

export class AnthropicModelProvider extends BaseModelProvider {
  constructor(options: ProviderAdapterOptions = {}) {
    super(options, {
      id: 'anthropic',
      baseUrl: DEFAULT_BASE_URL,
      capabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
    });
  }

  async generate(
    request: ModelRequest,
    context: ModelCallContext = {},
  ): Promise<ModelResponse> {
    const { model } = await this.prepare(request, context, false);
    const raw = await this.transport.request(
      this.createTransportRequest(
        'generate',
        '/messages',
        this.buildBody(request, model, false),
        this.headers(),
      ),
      context,
    );
    return this.parseResponse(raw, model, request);
  }

  stream(request: ModelRequest, context: ModelCallContext = {}): ModelStream {
    const state: AnthropicStreamState = {
      request,
      id: 'msg_stream',
      blocks: new Map(),
      usage: zeroUsage(),
    };
    const mapper: ModelStreamMapper<AnthropicStreamState> = {
      state,
      map: (event, current) => this.mapStreamEvent(event, current),
      finalize: current => this.finalizeStream(current),
    };
    return createModelStream({
      context,
      mapper,
      start: async streamContext => {
        const { model } = await this.prepare(request, streamContext, true);
        state.model = model;
        return this.transport.stream(
          this.createTransportRequest(
            'stream',
            '/messages',
            this.buildBody(request, model, true),
            this.headers(),
          ),
          streamContext,
        );
      },
    });
  }

  private buildBody(
    request: ModelRequest,
    model: ResolvedModel,
    streaming: boolean,
  ): Record<string, unknown> {
    const systemText = request.input
      .map(itemRecord)
      .filter(item => item.type === 'text' && item.role === 'system' && typeof item.text === 'string')
      .map(item => item.text as string)
      .join('\n\n');
    const system = !systemText
      ? undefined
      : request.promptCacheKey
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : systemText;
    const outputConfig = request.outputSchema || request.reasoning?.effort
      ? compactObject({
          effort: request.reasoning?.effort,
          format: request.outputSchema
            ? { type: 'json_schema', schema: request.outputSchema.schema }
            : undefined,
        })
      : undefined;
    const messages = request.input
      .filter(item => !(itemRecord(item).type === 'text' && itemRecord(item).role === 'system'))
      .map(item => this.mapInputItem(item));
    if (request.promptCacheKey && !systemText) {
      const lastMessage = messages.at(-1);
      if (isRecord(lastMessage) && Array.isArray(lastMessage.content)) {
        const content = [...lastMessage.content];
        const lastBlock = content.at(-1);
        if (isRecord(lastBlock)) {
          content[content.length - 1] = {
            ...lastBlock,
            cache_control: { type: 'ephemeral' },
          };
          lastMessage.content = content;
        }
      }
    }

    return compactObject({
      ...this.providerOptions(request),
      model: model.modelId,
      system,
      messages,
      max_tokens: request.maxOutputTokens ?? 4_096,
      temperature: request.temperature,
      stop_sequences: request.stopSequences,
      tools: request.tools?.map(tool => compactObject({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        strict: tool.strict,
        ...tool.providerOptions,
      })),
      tool_choice: mapToolPolicy(request.toolPolicy, request.parallelToolCalls),
      output_config: outputConfig,
      thinking: request.reasoning?.budgetTokens === undefined
        ? undefined
        : { type: 'enabled', budget_tokens: request.reasoning.budgetTokens },
      metadata: request.metadata,
      stream: streaming,
    });
  }

  private mapInputItem(item: InputItem): unknown {
    const record = itemRecord(item);
    switch (record.type) {
      case 'text':
        return {
          role: record.role === 'assistant' ? 'assistant' : 'user',
          content: [{ type: 'text', text: typeof record.text === 'string' ? record.text : '' }],
        };
      case 'image': {
        const source = imageSourceParts(item);
        return {
          role: source.role,
          content: [{
            type: 'image',
            source: source.kind === 'url'
              ? { type: 'url', url: source.url }
              : source.kind === 'base64'
                ? {
                    type: 'base64',
                    media_type: source.mediaType ?? 'image/png',
                    data: source.data ?? '',
                  }
                : { type: 'file', file_id: source.fileId },
          }],
        };
      }
      case 'document': {
        const source = isRecord(record.source) ? record.source : record;
        const type = source.kind ?? source.type;
        const mappedSource = type === 'url'
          ? { type: 'url', url: source.url }
          : type === 'file'
            ? { type: 'file', file_id: source.fileId ?? source.file_id }
            : {
                type: 'base64',
                media_type: source.mediaType ?? source.media_type ?? 'application/pdf',
                data: source.data,
              };
        return { role: 'user', content: [{ type: 'document', source: mappedSource }] };
      }
      case 'tool_call':
        return {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: String(record.id ?? ''),
            name: String(record.name ?? ''),
            input: record.input ?? {},
          }],
        };
      case 'tool_result':
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: String(record.callId ?? record.call_id ?? ''),
            content: stringifyToolValue(record.output),
            is_error: record.status === 'error',
          }],
        };
      case 'reasoning': {
        const opaque = record.opaque;
        return {
          role: 'assistant',
          content: [isRecord(opaque)
            ? opaque
            : { type: 'thinking', thinking: String(opaque ?? '') }],
        };
      }
      case 'raw': {
        const raw = providerRawInput(item);
        return isRecord(raw) && 'role' in raw
          ? raw
          : { role: 'assistant', content: [raw] };
      }
      case 'structured':
        return {
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify(record.value ?? null) }],
        };
      case 'refusal':
        return {
          role: 'assistant',
          content: [{ type: 'text', text: String(record.message ?? 'Refused.') }],
        };
      case 'error':
        return {
          role: 'user',
          content: [{
            type: 'text',
            text: `[${String(record.code ?? 'ERROR')}] ${String(record.message ?? '')}`,
          }],
        };
      default:
        return record;
    }
  }

  private parseResponse(
    raw: unknown,
    model: ResolvedModel,
    request: ModelRequest,
  ): ModelResponse {
    if (!isRecord(raw)) {
      throw new TypeError('Anthropic transport returned a non-object response.');
    }
    const output: OutputItem[] = [];
    for (const block of Array.isArray(raw.content) ? raw.content : []) {
      output.push(...this.mapOutputBlock(block));
    }
    if (raw.stop_reason === 'refusal' && !output.some(item => itemRecord(item).type === 'refusal')) {
      output.push(refusalOutput('The provider refused the request.', raw.stop_details));
    }
    const parsedStructuredOutput = attachStructuredOutput(request, output);
    return {
      id: typeof raw.id === 'string' ? raw.id : 'msg_unknown',
      model,
      output,
      finishReason: finishReason(raw.stop_reason),
      usage: anthropicUsage(raw.usage),
      structuredOutput: parsedStructuredOutput,
      ...(this.includeRawResponse ? { rawResponse: jsonValue(raw) } : {}),
    };
  }

  private mapOutputBlock(block: unknown): OutputItem[] {
    if (!isRecord(block)) {
      return this.preserveProviderItems ? [rawOutput(this.id, block)] : [];
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      return [textOutput(block.text)];
    }
    if (block.type === 'tool_use') {
      return [toolCallOutput(
        String(block.id ?? ''),
        String(block.name ?? ''),
        block.input ?? {},
      )];
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      return [reasoningOutput(
        this.id,
        block,
        typeof block.thinking === 'string' ? block.thinking : undefined,
      )];
    }
    if (block.type === 'refusal') {
      return [refusalOutput(String(block.explanation ?? block.text ?? 'Refused.'), block)];
    }
    return this.preserveProviderItems ? [rawOutput(this.id, block)] : [];
  }

  private mapStreamEvent(
    event: unknown,
    state: AnthropicStreamState,
  ): readonly ModelStreamEvent[] {
    if (!isRecord(event)) return [];
    const mapped: ModelStreamEvent[] = [];

    if (event.type === 'message_start' && isRecord(event.message)) {
      if (typeof event.message.id === 'string') state.id = event.message.id;
      if (isRecord(event.message.usage)) state.usage = anthropicUsage(event.message.usage);
    } else if (
      event.type === 'content_block_start' &&
      typeof event.index === 'number' &&
      isRecord(event.content_block)
    ) {
      state.blocks.set(event.index, streamBlock(event.content_block));
    } else if (
      event.type === 'content_block_delta' &&
      typeof event.index === 'number' &&
      isRecord(event.delta)
    ) {
      const block = state.blocks.get(event.index) ?? { type: 'raw', value: {} };
      state.blocks.set(event.index, block);
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
        if (block.type !== 'text') state.blocks.set(event.index, { type: 'text', text: event.delta.text });
        else block.text += event.delta.text;
        mapped.push({ type: 'text.delta', delta: event.delta.text, outputIndex: event.index });
      } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
        if (block.type !== 'reasoning') {
          state.blocks.set(event.index, { type: 'reasoning', text: event.delta.thinking, raw: {} });
        } else {
          block.text += event.delta.thinking;
        }
        mapped.push({ type: 'reasoning.delta', delta: event.delta.thinking, outputIndex: event.index });
      } else if (event.delta.type === 'signature_delta' && typeof event.delta.signature === 'string') {
        if (block.type === 'reasoning') block.signature = event.delta.signature;
      } else if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        if (block.type === 'tool') block.arguments += event.delta.partial_json;
        mapped.push({
          type: 'tool_call.delta',
          callId: block.type === 'tool' ? block.id : `tool_${event.index}`,
          name: block.type === 'tool' ? block.name : undefined,
          argumentsDelta: event.delta.partial_json,
          outputIndex: event.index,
        });
      }
    } else if (event.type === 'message_delta') {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.stop_reason !== undefined) state.finishReason = finishReason(delta.stop_reason);
      if (isRecord(event.usage)) {
        state.usage = mergeAnthropicStreamUsage(state.usage, anthropicUsage(event.usage));
        mapped.push({ type: 'usage', usage: state.usage });
      }
    } else if (event.type === 'message' || event.type === 'message_completed') {
      const message = isRecord(event.message) ? event.message : event;
      if (!state.model) throw new Error('Anthropic stream completed before model resolution.');
      state.response = this.parseResponse(message, state.model, state.request);
      mapped.push({ type: 'response.completed', response: state.response });
    }

    if (this.preserveProviderItems && event.type !== 'done') {
      mapped.push({ type: 'provider.event', provider: this.id, event: jsonValue(event) });
    }
    return mapped;
  }

  private finalizeStream(state: AnthropicStreamState): ModelResponse {
    if (state.response) return state.response;
    if (!state.model) throw new Error('Anthropic stream ended before model resolution.');
    const output: OutputItem[] = [];
    for (const [, block] of [...state.blocks.entries()].sort(([a], [b]) => a - b)) {
      if (block.type === 'text') output.push(textOutput(block.text));
      else if (block.type === 'reasoning') {
        output.push(reasoningOutput(
          this.id,
          compactObject({ type: 'thinking', thinking: block.text, signature: block.signature }),
          block.text,
        ));
      } else if (block.type === 'tool') {
        output.push(toolCallOutput(block.id, block.name, safeJsonParse(block.arguments) ?? {}));
      } else if (this.preserveProviderItems) output.push(rawOutput(this.id, block.value));
    }
    const parsedStructuredOutput = attachStructuredOutput(state.request, output);
    return {
      id: state.id,
      model: state.model,
      output,
      finishReason: state.finishReason ?? (output.some(item => itemRecord(item).type === 'tool_call') ? 'tool_calls' : 'stop'),
      usage: state.usage,
      structuredOutput: parsedStructuredOutput,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    else if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return headers;
  }
}

type AnthropicStreamBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string; raw: Record<string, unknown> }
  | { type: 'tool'; id: string; name: string; arguments: string }
  | { type: 'raw'; value: unknown };

interface AnthropicStreamState {
  readonly request: ModelRequest;
  model?: ResolvedModel;
  id: string;
  readonly blocks: Map<number, AnthropicStreamBlock>;
  usage: Usage;
  finishReason?: ModelResponse['finishReason'];
  response?: ModelResponse;
}

function streamBlock(value: Record<string, unknown>): AnthropicStreamBlock {
  if (value.type === 'text') return { type: 'text', text: String(value.text ?? '') };
  if (value.type === 'thinking' || value.type === 'redacted_thinking') {
    return {
      type: 'reasoning',
      text: String(value.thinking ?? ''),
      signature: typeof value.signature === 'string' ? value.signature : undefined,
      raw: value,
    };
  }
  if (value.type === 'tool_use') {
    return {
      type: 'tool',
      id: String(value.id ?? ''),
      name: String(value.name ?? ''),
      arguments: isRecord(value.input) && Object.keys(value.input).length > 0
        ? JSON.stringify(value.input)
        : '',
    };
  }
  return { type: 'raw', value };
}

function mapToolPolicy(
  policy: ModelRequest['toolPolicy'],
  parallel: boolean | undefined,
): unknown {
  if (!policy && parallel === undefined) return undefined;
  const disableParallel = parallel === undefined ? undefined : !parallel;
  if (!policy || policy === 'auto') {
    return compactObject({ type: 'auto', disable_parallel_tool_use: disableParallel });
  }
  if (policy === 'none') {
    return compactObject({ type: 'none', disable_parallel_tool_use: disableParallel });
  }
  if (policy === 'required') {
    return compactObject({ type: 'any', disable_parallel_tool_use: disableParallel });
  }
  return compactObject({ type: 'tool', name: policy.name, disable_parallel_tool_use: disableParallel });
}

function anthropicUsage(value: unknown): Usage {
  const base = usageFromProvider(value, {
    input: ['input_tokens'],
    output: ['output_tokens'],
    cacheWrite: ['cache_creation_input_tokens'],
    cachedInput: ['cache_read_input_tokens'],
    reasoning: ['output_tokens_details.thinking_tokens'],
  });
  const inputTokens = base.inputTokens + base.cacheReadTokens + base.cacheWriteTokens;
  return {
    ...base,
    inputTokens,
    totalTokens: inputTokens + base.outputTokens,
  };
}

function mergeAnthropicStreamUsage(start: Usage, delta: Usage): Usage {
  const inputTokens = Math.max(start.inputTokens, delta.inputTokens);
  const outputTokens = Math.max(start.outputTokens, delta.outputTokens);
  return {
    ...start,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: Math.max(start.cacheReadTokens, delta.cacheReadTokens),
    cacheWriteTokens: Math.max(start.cacheWriteTokens, delta.cacheWriteTokens),
    reasoningTokens: Math.max(start.reasoningTokens, delta.reasoningTokens),
  };
}
