import type {
  ContentBlock,
  Message,
  MessageParam,
  MessageStreamEvent,
  Tool as ProviderTool,
  ToolChoice,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from './types.js';
import type { ModelApi, ModelRequest, ModelStreamHandle } from '../types.js';
import type {
  OpenaiChatCompletion,
  OpenaiChatCompletionRequest,
  OpenaiMessage,
  OpenaiMessageContentText,
  OpenaiMessageContentImage,
  OpenaiTool,
} from './openai-types.js';
import OpenaiProviderClient, { OpenaiProviderMessageStream } from './openai-client.js';
import type { ResolvedRuntimeConfig } from '../types.js';

// ── Request: Anthropic → OpenAI ─────────────────────────────────

function anthropicMessagesToOpenai(msgs: MessageParam[]): OpenaiMessage[] {
  const openaiMsgs: OpenaiMessage[] = [];

  for (const msg of msgs) {
    if (typeof msg.content === 'string') {
      openaiMsgs.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      continue;
    }

    // Content is ContentBlockParam[]
    const contentParts: (OpenaiMessageContentText | OpenaiMessageContentImage)[] = [];
    let toolCalls: OpenaiMessage['tool_calls'] | undefined;
    let hasImage = false;

    for (const block of msg.content) {
      if (!isRecord(block)) continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        contentParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const tc = block as ToolUseBlock;
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        });
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultBlockParam;
        const content = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.map((c) => (typeof c === 'object' && c !== null && 'text' in c ? (c as { text: string }).text : '')).join('')
            : '';
        openaiMsgs.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: content || (tr.is_error ? 'Error' : ''),
        });
      } else if (block.type === 'image' && 'source' in block && block.source) {
        const img = block as unknown as { source: { type?: string; media_type?: string; data?: string } };
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.source.media_type ?? 'image/png'};base64,${img.source.data ?? ''}`,
          },
        });
        hasImage = true;
      }
    }

    if (msg.role === 'assistant' && toolCalls && toolCalls.length > 0) {
      openaiMsgs.push({
        role: 'assistant',
        content: contentParts.length > 0 ? contentParts : null,
        tool_calls: toolCalls,
      });
    } else if (contentParts.length > 0 || msg.role === 'assistant' || hasImage) {
      openaiMsgs.push({
        role: msg.role as 'user' | 'assistant',
        content: contentParts.length > 0 ? contentParts : null,
      });
    }
  }

  return openaiMsgs;
}

function providerToolsToOpenai(tools?: ProviderTool[]): OpenaiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function mapToolChoice(toolChoice?: ToolChoice): OpenaiChatCompletionRequest['tool_choice'] {
  if (!toolChoice) return undefined;
  const tc = toolChoice as Record<string, unknown>;
  if (tc.type === 'none') return 'none';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && typeof tc.name === 'string') {
    return { type: 'function', function: { name: tc.name as string } };
  }
  // auto or default
  return 'auto';
}

// ── Response: OpenAI → Anthropic ─────────────────────────────────

import { robustJsonParse } from './json-parse.js';

function openaiToAnthropicMessage(completion: OpenaiChatCompletion): Message {
  const choice = completion.choices[0];
  const content: ContentBlock[] = [];
  let stopReason: Message['stop_reason'] = null;

  if (choice) {
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const input = robustJsonParse(tc.function.arguments, tc.function.name);
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }
    stopReason = mapFinishReason(choice.finish_reason);
  }

  return {
    id: completion.id,
    type: 'message',
    role: 'assistant',
    model: completion.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(completion.usage),
  };
}

function mapFinishReason(finish: string | null): Message['stop_reason'] {
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return finish as Message['stop_reason'];
  }
}

function mapUsage(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): Usage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    ...usage,
  };
}

// ── Streaming adapter ────────────────────────────────────────────

class OpenaiStreamAdapter implements ModelStreamHandle {
  private started = false;
  private accumulated: OpenaiChatCompletionChunkAccumulator;
  private startedBlockIndices = new Set<number>();

  constructor(
    private readonly inner: OpenaiProviderMessageStream,
  ) {
    this.accumulated = new OpenaiChatCompletionChunkAccumulator();
  }

  async finalMessage(): Promise<Message> {
    // Drain the stream if not consumed
    if (!this.started) {
      for await (const _ of this) { /* drain */ }
    }
    // Get the OpenAI completion and convert
    const completion = this.accumulated.toCompletion();
    return openaiToAnthropicMessage(completion);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    if (this.started) throw new Error('Stream already consumed.');
    this.started = true;

    let contentBlockIndex = -1;
    let emittedMessageStart = false;

    for await (const chunk of this.inner) {
      this.accumulated.add(chunk);

      for (const choice of chunk.choices) {
        if (!emittedMessageStart) {
          emittedMessageStart = true;
          yield {
            type: 'message_start',
            message: {
              id: chunk.id,
              type: 'message',
              role: 'assistant',
              model: chunk.model,
              content: [],
              stop_reason: null,
            },
          };
        }

        if (choice.delta.content !== null && choice.delta.content !== undefined) {
          // Start a text content block on first content delta
          if (contentBlockIndex === -1) {
            contentBlockIndex = 0;
            this.startedBlockIndices.add(contentBlockIndex);
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'text_delta', text: choice.delta.content },
          };
        }

        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const blockIndex = tc.index + (contentBlockIndex >= 0 ? contentBlockIndex + 1 : 0);
            if (tc.id) {
              // New tool call block starting
              this.startedBlockIndices.add(blockIndex);
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function?.name ?? '',
                  input: {},
                },
              };
            }
            if (tc.function?.arguments) {
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              };
            }
          }
        }

        if (choice.finish_reason) {
          // Stop all content blocks that were started
          const indices = [...this.startedBlockIndices].sort((a, b) => a - b);
          for (const idx of indices) {
            yield { type: 'content_block_stop', index: idx };
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: mapFinishReason(choice.finish_reason) },
          };
        }
      }
    }

    // Use last accumulated usage if available
    const completion = this.accumulated.toCompletion();
    if (completion.usage) {
      yield {
        type: 'message_delta',
        delta: {},
        usage: mapUsage(completion.usage) as Usage,
      };
    }
    yield { type: 'message_stop' };
  }
}

// Accumulate OpenAI SSE chunks into a complete ChatCompletion
class OpenaiChatCompletionChunkAccumulator {
  private chunks: Array<{ id: string; model: string; created: number; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> = [];
  private choiceAcc = new Map<number, {
    role: string;
    content: string;
    toolCalls: Map<number, { id: string; name: string; args: string }>;
    finish_reason: string | null;
  }>();

  add(chunk: { id: string; model: string; created: number; choices: Array<{ index: number; delta: { role?: string; content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }) {
    this.chunks.push({ id: chunk.id, model: chunk.model, created: chunk.created, usage: chunk.usage });

    for (const choice of chunk.choices) {
      if (!this.choiceAcc.has(choice.index)) {
        this.choiceAcc.set(choice.index, {
          role: choice.delta.role ?? '',
          content: '',
          toolCalls: new Map(),
          finish_reason: null,
        });
      }
      const acc = this.choiceAcc.get(choice.index)!;

      if (choice.delta.content) acc.content += choice.delta.content;
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!acc.toolCalls.has(tc.index)) {
            acc.toolCalls.set(tc.index, { id: '', name: '', args: '' });
          }
          const atc = acc.toolCalls.get(tc.index)!;
          if (tc.id) atc.id = tc.id;
          if (tc.function?.name) atc.name = tc.function.name;
          if (tc.function?.arguments) atc.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) acc.finish_reason = choice.finish_reason;
    }
  }

  toCompletion(): OpenaiChatCompletion {
    const first = this.chunks[0];
    const lastUsage = [...this.chunks].reverse().find((c) => c.usage);
    return {
      id: first?.id ?? 'chatcmpl_unknown',
      object: 'chat.completion',
      created: first?.created ?? Math.floor(Date.now() / 1000),
      model: first?.model ?? 'unknown',
      usage: lastUsage?.usage as OpenaiChatCompletion['usage'],
      choices: [...this.choiceAcc.entries()].map(([index, acc]) => ({
        index,
        message: {
          role: (acc.role || 'assistant') as 'assistant',
          content: acc.content || null,
          tool_calls: acc.toolCalls.size > 0
            ? [...acc.toolCalls.entries()].map(([, tc]) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.args },
              }))
            : undefined,
        },
        finish_reason: acc.finish_reason,
      })),
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ── ModelApi implementation ──────────────────────────────────────

export class OpenaiModelApi implements ModelApi {
  constructor(private readonly client: OpenaiProviderClient) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    const { signal, ...rest } = request;
    const body = this.buildRequest(rest);
    const completion = await this.client.chat.completions.create(body, signal);
    return openaiToAnthropicMessage(completion);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    const { signal, ...rest } = request;
    const body = this.buildRequest(rest);
    const inner = this.client.chat.completions.stream(body, signal);
    return new OpenaiStreamAdapter(inner);
  }

  private buildRequest(request: Omit<ModelRequest, 'signal'>): OpenaiChatCompletionRequest {
    const openaiMessages = anthropicMessagesToOpenai(request.messages);

    // Prepend system message if present
    if (request.system) {
      openaiMessages.unshift({ role: 'system', content: request.system });
    }

    const tc = request.tool_choice as Record<string, unknown> | undefined;
    const body: OpenaiChatCompletionRequest = {
      model: request.model,
      messages: openaiMessages,
      max_completion_tokens: request.max_tokens,
      temperature: request.temperature,
      tools: providerToolsToOpenai(request.tools),
      tool_choice: mapToolChoice(request.tool_choice),
      stop: request.stop_sequences,
      reasoning_effort:
        request.effort === 'max'
          ? 'high'
          : request.effort,
    };

    if (tc?.disable_parallel_tool_use !== undefined) {
      body.parallel_tool_calls = !tc.disable_parallel_tool_use;
    }

    return body;
  }
}

// ── Factory ──────────────────────────────────────────────────────

export function createOpenaiModelApi(config: ResolvedRuntimeConfig): ModelApi {
  const client = new OpenaiProviderClient({
    apiKey: config.apiKey ?? null,
    authToken: config.authToken ?? null,
    baseURL: config.baseURL ?? null,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  return new OpenaiModelApi(client);
}
