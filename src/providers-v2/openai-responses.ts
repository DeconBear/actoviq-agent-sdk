import type { InputItem, JsonValue, OutputItem, Usage } from '../core/index.js';

import {
  BaseModelProvider,
  compactObject,
  isRecord,
  safeJsonParse,
  stringifyToolValue,
} from './adapter-base.js';
import { OPENAI_RESPONSES_CAPABILITIES } from './capabilities.js';
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

export class OpenAIResponsesProvider extends BaseModelProvider {
  constructor(options: ProviderAdapterOptions = {}) {
    super(options, {
      id: 'openai-responses',
      baseUrl: DEFAULT_BASE_URL,
      capabilities: OPENAI_RESPONSES_CAPABILITIES,
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
        '/responses',
        this.buildBody(request, model, false),
        this.headers(),
      ),
      context,
    );
    return this.parseResponse(raw, model, request);
  }

  stream(request: ModelRequest, context: ModelCallContext = {}): ModelStream {
    const state: ResponsesStreamState = {
      request,
      text: '',
      toolArguments: new Map(),
      output: [],
      usage: zeroUsage(),
    };
    const mapper: ModelStreamMapper<ResponsesStreamState> = {
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
            '/responses',
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
    const providerOptions = this.providerOptions(request);
    const text = request.outputSchema
      ? {
          format: compactObject({
            type: 'json_schema',
            name: request.outputSchema.name,
            description: request.outputSchema.description,
            schema: request.outputSchema.schema,
            strict: request.outputSchema.strict ?? true,
          }),
        }
      : undefined;

    return compactObject({
      ...providerOptions,
      model: model.modelId,
      input: request.input.map(item => this.mapInputItem(item)),
      tools: request.tools?.map(tool => {
        if (tool.hosted) {
          return { ...tool.providerOptions, name: tool.name };
        }
        return compactObject({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: tool.strict,
        });
      }),
      tool_choice: mapToolPolicy(request.toolPolicy),
      parallel_tool_calls: request.parallelToolCalls,
      text,
      reasoning: request.reasoning
        ? compactObject({
            effort: normalizeEffort(request.reasoning.effort),
            summary: request.reasoning.summary === 'none' ? undefined : request.reasoning.summary,
          })
        : undefined,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      stop: request.stopSequences,
      prompt_cache_key: request.promptCacheKey,
      metadata: request.metadata,
      stream: streaming,
    });
  }

  private mapInputItem(item: InputItem): unknown {
    const record = itemRecord(item);
    switch (record.type) {
      case 'text': {
        const role = record.role === 'assistant'
          ? 'assistant'
          : record.role === 'system'
            ? 'system'
            : 'user';
        return {
          role,
          content: [{
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: typeof record.text === 'string' ? record.text : '',
          }],
        };
      }
      case 'image': {
        const source = imageSourceParts(item);
        return {
          role: source.role,
          content: [compactObject({
            type: 'input_image',
            detail: source.detail,
            image_url: source.kind === 'url'
              ? source.url
              : source.kind === 'base64'
                ? `data:${source.mediaType ?? 'image/png'};base64,${source.data ?? ''}`
                : undefined,
            file_id: source.kind === 'file' ? source.fileId : undefined,
          })],
        };
      }
      case 'tool_call':
        return {
          type: 'function_call',
          call_id: String(record.id ?? ''),
          name: String(record.name ?? ''),
          arguments: JSON.stringify(record.input ?? {}),
        };
      case 'tool_result':
        return {
          type: 'function_call_output',
          call_id: String(record.callId ?? record.call_id ?? ''),
          output: stringifyToolValue(record.output),
        };
      case 'reasoning': {
        const opaque = record.opaque;
        return isRecord(opaque) ? opaque : { type: 'reasoning', content: opaque };
      }
      case 'raw':
        return providerRawInput(item);
      case 'structured':
        return {
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(record.value ?? null) }],
        };
      case 'refusal':
        return {
          role: 'assistant',
          content: [{ type: 'output_text', text: String(record.message ?? 'Refused.') }],
        };
      case 'error':
        return {
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[${String(record.code ?? 'ERROR')}] ${String(record.message ?? '')}`,
          }],
        };
      case 'document': {
        const source = isRecord(record.source) ? record.source : record;
        return {
          role: record.role === 'assistant' ? 'assistant' : 'user',
          content: [compactObject({
            type: 'input_file',
            file_id: source.fileId ?? source.file_id,
            file_url: source.url,
            file_data: source.data,
            filename: record.name ?? source.filename,
          })],
        };
      }
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
      throw new TypeError('OpenAI Responses transport returned a non-object response.');
    }
    const output: OutputItem[] = [];
    for (const item of Array.isArray(raw.output) ? raw.output : []) {
      output.push(...this.mapOutputItem(item));
    }
    const hasToolCall = output.some(item => itemRecord(item).type === 'tool_call');
    const parsedStructuredOutput = attachStructuredOutput(request, output);
    const response: ModelResponse = {
      id: typeof raw.id === 'string' ? raw.id : 'resp_unknown',
      model,
      output,
      finishReason: hasToolCall
        ? 'tool_calls'
        : finishReason(
            isRecord(raw.incomplete_details)
              ? raw.incomplete_details.reason
              : raw.status,
          ),
      usage: openAIUsage(raw.usage),
      structuredOutput: parsedStructuredOutput,
      ...(this.includeRawResponse ? { rawResponse: jsonValue(raw) } : {}),
    };
    return response;
  }

  private mapOutputItem(value: unknown): OutputItem[] {
    if (!isRecord(value)) {
      return this.preserveProviderItems ? [rawOutput(this.id, value)] : [];
    }
    if (value.type === 'message') {
      const result: OutputItem[] = [];
      for (const content of Array.isArray(value.content) ? value.content : []) {
        if (!isRecord(content)) {
          if (this.preserveProviderItems) result.push(rawOutput(this.id, content));
        } else if (content.type === 'output_text' && typeof content.text === 'string') {
          result.push(textOutput(content.text));
        } else if (content.type === 'refusal') {
          result.push(refusalOutput(String(content.refusal ?? content.text ?? 'Refused.'), content));
        } else if (this.preserveProviderItems) {
          result.push(rawOutput(this.id, content));
        }
      }
      return result;
    }
    if (value.type === 'function_call') {
      return [toolCallOutput(
        String(value.call_id ?? value.id ?? ''),
        String(value.name ?? ''),
        safeJsonParse(value.arguments) ?? {},
      )];
    }
    if (value.type === 'reasoning') {
      const summary = Array.isArray(value.summary)
        ? value.summary
            .filter(isRecord)
            .map(entry => typeof entry.text === 'string' ? entry.text : '')
            .join('')
        : undefined;
      return [reasoningOutput(this.id, value, summary || undefined)];
    }
    return this.preserveProviderItems ? [rawOutput(this.id, value)] : [];
  }

  private mapStreamEvent(
    event: unknown,
    state: ResponsesStreamState,
  ): readonly ModelStreamEvent[] {
    if (!isRecord(event)) return [];
    const mapped: ModelStreamEvent[] = [];

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      state.text += event.delta;
      mapped.push({
        type: 'text.delta',
        delta: event.delta,
        outputIndex: numberOrUndefined(event.output_index),
      });
    } else if (
      event.type === 'response.function_call_arguments.delta' &&
      typeof event.delta === 'string'
    ) {
      const callId = String(event.item_id ?? event.call_id ?? event.output_index ?? 'call_stream');
      state.toolArguments.set(callId, `${state.toolArguments.get(callId) ?? ''}${event.delta}`);
      mapped.push({
        type: 'tool_call.delta',
        callId,
        name: typeof event.name === 'string' ? event.name : undefined,
        argumentsDelta: event.delta,
        outputIndex: numberOrUndefined(event.output_index),
      });
    } else if (
      (event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta') &&
      typeof event.delta === 'string'
    ) {
      state.reasoning = `${state.reasoning ?? ''}${event.delta}`;
      mapped.push({
        type: 'reasoning.delta',
        delta: event.delta,
        outputIndex: numberOrUndefined(event.output_index),
      });
    } else if (event.type === 'response.output_item.done' && 'item' in event) {
      state.output.push(...this.mapOutputItem(event.item));
    } else if (event.type === 'response.completed' && isRecord(event.response)) {
      if (!state.model) throw new Error('OpenAI Responses stream completed before model resolution.');
      state.response = this.parseResponse(event.response, state.model, state.request);
      mapped.push({ type: 'response.completed', response: state.response });
    } else if ((event.type === 'response.failed' || event.type === 'response.incomplete') && isRecord(event.response)) {
      if (!state.model) throw new Error('OpenAI Responses stream failed before model resolution.');
      state.response = this.parseResponse(event.response, state.model, state.request);
      mapped.push({ type: 'response.completed', response: state.response });
    } else if (event.object === 'response') {
      if (!state.model) throw new Error('OpenAI Responses stream completed before model resolution.');
      state.response = this.parseResponse(event, state.model, state.request);
      mapped.push({ type: 'response.completed', response: state.response });
    }

    if (this.preserveProviderItems && event.type !== 'done') {
      mapped.push({ type: 'provider.event', provider: this.id, event: jsonValue(event) });
    }
    return mapped;
  }

  private finalizeStream(state: ResponsesStreamState): ModelResponse {
    if (state.response) return state.response;
    if (!state.model) throw new Error('OpenAI Responses stream ended before model resolution.');

    const output = state.output.length > 0 ? [...state.output] : [];
    if (state.text && !output.some(item => itemRecord(item).type === 'text')) {
      output.push(textOutput(state.text));
    }
    if (state.reasoning && !output.some(item => itemRecord(item).type === 'reasoning')) {
      output.unshift(reasoningOutput(this.id, { summary: state.reasoning }, state.reasoning));
    }
    for (const [callId, argumentsJson] of state.toolArguments) {
      if (!output.some(item => itemRecord(item).type === 'tool_call' && itemRecord(item).id === callId)) {
        output.push(toolCallOutput(callId, '', safeJsonParse(argumentsJson)));
      }
    }
    const parsedStructuredOutput = attachStructuredOutput(state.request, output);
    return {
      id: 'resp_stream',
      model: state.model,
      output,
      finishReason: output.some(item => itemRecord(item).type === 'tool_call')
        ? 'tool_calls'
        : 'stop',
      usage: state.usage,
      structuredOutput: parsedStructuredOutput,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    const credential = this.authToken ?? this.apiKey;
    if (credential) headers.authorization = `Bearer ${credential}`;
    return headers;
  }
}

interface ResponsesStreamState {
  readonly request: ModelRequest;
  model?: ResolvedModel;
  text: string;
  reasoning?: string;
  readonly toolArguments: Map<string, string>;
  readonly output: OutputItem[];
  usage: Usage;
  response?: ModelResponse;
}

function mapToolPolicy(policy: ModelRequest['toolPolicy']): unknown {
  if (!policy) return undefined;
  if (typeof policy === 'string') return policy;
  return { type: 'function', name: policy.name };
}

function normalizeEffort(value: ModelReasoningRequest['effort']): string | undefined {
  return value === 'max' ? 'xhigh' : value;
}

function openAIUsage(value: unknown): Usage {
  return usageFromProvider(value, {
    input: ['input_tokens'],
    output: ['output_tokens'],
    total: ['total_tokens'],
    cachedInput: ['input_tokens_details.cached_tokens'],
    reasoning: ['output_tokens_details.reasoning_tokens'],
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
