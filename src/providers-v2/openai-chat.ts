import type { InputItem, JsonValue, OutputItem, Usage } from '../core/index.js';

import {
  BaseModelProvider,
  compactObject,
  isRecord,
  safeJsonParse,
  stringifyToolValue,
} from './adapter-base.js';
import { OPENAI_CHAT_COMPAT_CAPABILITIES } from './capabilities.js';
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
  ModelReasoningRequest,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
  ProviderAdapterOptions,
  ResolvedModel,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Compatibility adapter. New integrations should prefer OpenAIResponsesProvider. */
export class OpenAIChatCompatProvider extends BaseModelProvider {
  constructor(options: ProviderAdapterOptions = {}) {
    super(options, {
      id: 'openai-chat',
      baseUrl: DEFAULT_BASE_URL,
      capabilities: OPENAI_CHAT_COMPAT_CAPABILITIES,
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
        '/chat/completions',
        this.buildBody(request, model, false),
        this.headers(),
      ),
      context,
    );
    return this.parseResponse(raw, model, request);
  }

  stream(request: ModelRequest, context: ModelCallContext = {}): ModelStream {
    const state: ChatStreamState = {
      request,
      text: '',
      reasoning: '',
      toolCalls: new Map(),
      usage: zeroUsage(),
    };
    const mapper: ModelStreamMapper<ChatStreamState> = {
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
            '/chat/completions',
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
    const responseFormat = request.outputSchema
      ? {
          type: 'json_schema',
          json_schema: compactObject({
            name: request.outputSchema.name,
            description: request.outputSchema.description,
            schema: request.outputSchema.schema,
            strict: request.outputSchema.strict ?? true,
          }),
        }
      : undefined;

    return compactObject({
      ...this.providerOptions(request),
      model: model.modelId,
      messages: request.input.map(item => this.mapInputItem(item)),
      tools: request.tools?.map(tool => ({
        type: 'function',
        function: compactObject({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: tool.strict,
        }),
      })),
      tool_choice: mapToolPolicy(request.toolPolicy),
      parallel_tool_calls: request.parallelToolCalls,
      response_format: responseFormat,
      reasoning_effort: normalizeEffort(request.reasoning?.effort),
      max_completion_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      stop: request.stopSequences,
      metadata: request.metadata,
      stream: streaming,
      stream_options: streaming ? { include_usage: true } : undefined,
    });
  }

  private mapInputItem(item: InputItem): unknown {
    const record = itemRecord(item);
    switch (record.type) {
      case 'text':
        return {
          role: record.role === 'system'
            ? 'system'
            : record.role === 'assistant'
              ? 'assistant'
              : 'user',
          content: typeof record.text === 'string' ? record.text : '',
        };
      case 'image': {
        const source = imageSourceParts(item);
        const url = source.kind === 'url'
          ? source.url
          : source.kind === 'base64'
            ? `data:${source.mediaType ?? 'image/png'};base64,${source.data ?? ''}`
            : source.fileId;
        return {
          role: source.role,
          content: [{
            type: 'image_url',
            image_url: compactObject({ url, detail: source.detail }),
          }],
        };
      }
      case 'tool_call':
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: String(record.id ?? ''),
            type: 'function',
            function: {
              name: String(record.name ?? ''),
              arguments: JSON.stringify(record.input ?? {}),
            },
          }],
        };
      case 'tool_result':
        return {
          role: 'tool',
          tool_call_id: String(record.callId ?? record.call_id ?? ''),
          content: stringifyToolValue(record.output),
        };
      case 'reasoning':
        return {
          role: 'assistant',
          content: null,
          reasoning_content: record.opaque,
        };
      case 'raw':
        return providerRawInput(item);
      case 'structured':
        return {
          role: 'assistant',
          content: JSON.stringify(record.value ?? null),
        };
      case 'refusal':
        return { role: 'assistant', content: String(record.message ?? 'Refused.') };
      case 'error':
        return {
          role: 'user',
          content: `[${String(record.code ?? 'ERROR')}] ${String(record.message ?? '')}`,
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
      throw new TypeError('OpenAI Chat transport returned a non-object response.');
    }
    const choice = Array.isArray(raw.choices) && isRecord(raw.choices[0])
      ? raw.choices[0]
      : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const output = this.mapMessage(message);
    const parsedStructuredOutput = attachStructuredOutput(request, output);
    const response: ModelResponse = {
      id: typeof raw.id === 'string' ? raw.id : 'chatcmpl_unknown',
      model,
      output,
      finishReason: finishReason(choice.finish_reason),
      usage: openAIUsage(raw.usage),
      structuredOutput: parsedStructuredOutput,
      ...(this.includeRawResponse ? { rawResponse: jsonValue(raw) } : {}),
    };
    return response;
  }

  private mapMessage(message: Record<string, unknown>): OutputItem[] {
    const output: OutputItem[] = [];
    if (typeof message.content === 'string' && message.content.length > 0) {
      output.push(textOutput(message.content));
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && (part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') {
          output.push(textOutput(part.text));
        } else if (isRecord(part) && part.type === 'refusal') {
          output.push(refusalOutput(String(part.refusal ?? part.text ?? 'Refused.'), part));
        } else if (this.preserveProviderItems) {
          output.push(rawOutput(this.id, part));
        }
      }
    }
    if (typeof message.refusal === 'string' && message.refusal.length > 0) {
      output.push(refusalOutput(message.refusal));
    }

    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      output.push(toolCallOutput(
        String(toolCall.id ?? ''),
        String(fn.name ?? ''),
        safeJsonParse(fn.arguments) ?? {},
      ));
    }

    const reasoning = message.reasoning_content ?? message.reasoning ?? message.reasoning_details;
    if (reasoning !== undefined && reasoning !== null) {
      output.unshift(reasoningOutput(
        this.id,
        reasoning,
        typeof reasoning === 'string' ? reasoning : undefined,
      ));
    }
    return output;
  }

  private mapStreamEvent(
    event: unknown,
    state: ChatStreamState,
  ): readonly ModelStreamEvent[] {
    if (!isRecord(event)) return [];
    const mapped: ModelStreamEvent[] = [];

    if (event.object === 'chat.completion') {
      if (!state.model) throw new Error('OpenAI Chat stream completed before model resolution.');
      state.response = this.parseResponse(event, state.model, state.request);
      mapped.push({ type: 'response.completed', response: state.response });
    } else {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const index = numberOrUndefined(choice.index);
        if (typeof delta.content === 'string') {
          state.text += delta.content;
          mapped.push({ type: 'text.delta', delta: delta.content, outputIndex: index });
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string') {
          state.reasoning += reasoning;
          mapped.push({ type: 'reasoning.delta', delta: reasoning, outputIndex: index });
        }
        for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isRecord(toolDelta)) continue;
          const toolIndex = numberOrUndefined(toolDelta.index) ?? state.toolCalls.size;
          const existing = state.toolCalls.get(toolIndex) ?? { id: '', name: '', arguments: '' };
          const fn = isRecord(toolDelta.function) ? toolDelta.function : {};
          if (typeof toolDelta.id === 'string') existing.id = toolDelta.id;
          if (typeof fn.name === 'string') existing.name += fn.name;
          const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
          existing.arguments += argumentsDelta;
          state.toolCalls.set(toolIndex, existing);
          if (argumentsDelta || existing.id || existing.name) {
            mapped.push({
              type: 'tool_call.delta',
              callId: existing.id || `call_${toolIndex}`,
              name: existing.name || undefined,
              argumentsDelta,
              outputIndex: toolIndex,
            });
          }
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          state.finishReason = finishReason(choice.finish_reason);
        }
      }
      if (isRecord(event.usage)) {
        state.usage = openAIUsage(event.usage);
        mapped.push({ type: 'usage', usage: state.usage });
      }
    }

    if (this.preserveProviderItems && event.type !== 'done') {
      mapped.push({ type: 'provider.event', provider: this.id, event: jsonValue(event) });
    }
    return mapped;
  }

  private finalizeStream(state: ChatStreamState): ModelResponse {
    if (state.response) return state.response;
    if (!state.model) throw new Error('OpenAI Chat stream ended before model resolution.');
    const output: OutputItem[] = [];
    if (state.reasoning) {
      output.push(reasoningOutput(this.id, state.reasoning, state.reasoning));
    }
    if (state.text) output.push(textOutput(state.text));
    for (const [, toolCall] of [...state.toolCalls.entries()].sort(([a], [b]) => a - b)) {
      output.push(toolCallOutput(
        toolCall.id,
        toolCall.name,
        safeJsonParse(toolCall.arguments) ?? {},
      ));
    }
    const parsedStructuredOutput = attachStructuredOutput(state.request, output);
    return {
      id: 'chatcmpl_stream',
      model: state.model,
      output,
      finishReason: state.finishReason ?? (state.toolCalls.size > 0 ? 'tool_calls' : 'stop'),
      usage: state.usage,
      structuredOutput: parsedStructuredOutput,
    };
  }

  private headers(): Record<string, string> {
    const credential = this.authToken ?? this.apiKey;
    return credential ? { authorization: `Bearer ${credential}` } : {};
  }
}

interface ChatStreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatStreamState {
  readonly request: ModelRequest;
  model?: ResolvedModel;
  text: string;
  reasoning: string;
  readonly toolCalls: Map<number, ChatStreamToolCall>;
  usage: Usage;
  finishReason?: ModelResponse['finishReason'];
  response?: ModelResponse;
}

function mapToolPolicy(policy: ModelRequest['toolPolicy']): unknown {
  if (!policy) return undefined;
  if (policy === 'required' || policy === 'auto' || policy === 'none') return policy;
  return { type: 'function', function: { name: policy.name } };
}

function normalizeEffort(value: ModelReasoningRequest['effort']): string | undefined {
  return value === 'max' ? 'high' : value;
}

function openAIUsage(value: unknown): Usage {
  return usageFromProvider(value, {
    input: ['prompt_tokens'],
    output: ['completion_tokens'],
    total: ['total_tokens'],
    cachedInput: ['prompt_tokens_details.cached_tokens'],
    reasoning: ['completion_tokens_details.reasoning_tokens'],
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
