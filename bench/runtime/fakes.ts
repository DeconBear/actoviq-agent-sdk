import type { ModelRef, Usage } from '../../src/core/index.js';
import { MINIMAL_MODEL_CAPABILITIES } from '../../src/providers-v2/capabilities.js';
import type {
  ModelCallContext,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
  ResolvedModel,
} from '../../src/providers-v2/types.js';
import type { McpClientLike } from '../../src/mcp/connectionManager.js';

const BENCH_USAGE: Usage = Object.freeze({
  requests: 1,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  costUsd: 0,
});

/** Deterministic in-memory provider used by every runtime benchmark. */
export class DeterministicModelProvider implements ModelProvider {
  readonly calls = { resolve: 0, capabilities: 0, generate: 0, stream: 0 };

  constructor(
    readonly id = 'benchmark',
    readonly text = 'deterministic benchmark output',
  ) {}

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    this.calls.resolve += 1;
    const parsed = parseModelRef(ref, this.id);
    if (parsed.providerId !== this.id) {
      throw new TypeError(`Provider ${this.id} cannot resolve ${parsed.providerId}.`);
    }
    return Object.freeze({
      providerId: this.id,
      modelId: parsed.modelId,
      ref,
    });
  }

  async capabilities(_model: ResolvedModel): Promise<ModelCapabilities> {
    this.calls.capabilities += 1;
    return MINIMAL_MODEL_CAPABILITIES;
  }

  async generate(
    request: ModelRequest,
    context: ModelCallContext,
  ): Promise<ModelResponse> {
    context.signal?.throwIfAborted();
    this.calls.generate += 1;
    const model = isResolved(request.model) ? request.model : await this.resolve(request.model);
    return responseFor(model, this.text, this.calls.generate);
  }

  stream(request: ModelRequest, context: ModelCallContext): ModelStream {
    context.signal?.throwIfAborted();
    this.calls.stream += 1;
    const response = Promise.resolve(request.model)
      .then(model => isResolved(model) ? model : this.resolve(model))
      .then(model => responseFor(model, this.text, this.calls.stream));
    return new DeterministicModelStream(response, this.text, context.signal);
  }
}

class DeterministicModelStream implements ModelStream {
  private started = false;
  private cancelled: unknown;

  constructor(
    private readonly response: Promise<ModelResponse>,
    private readonly text: string,
    private readonly signal?: AbortSignal,
  ) {}

  cancel(reason?: unknown): void {
    this.cancelled = reason ?? new Error('Benchmark stream cancelled.');
  }

  async finalResponse(): Promise<ModelResponse> {
    if (this.cancelled) throw this.cancelled;
    this.signal?.throwIfAborted();
    return this.response;
  }

  [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
    if (this.started) throw new Error('Benchmark streams are single-consumer iterables.');
    this.started = true;
    return this.consume()[Symbol.asyncIterator]();
  }

  private async *consume(): AsyncGenerator<ModelStreamEvent> {
    if (this.cancelled) throw this.cancelled;
    this.signal?.throwIfAborted();
    yield { type: 'text.delta', delta: this.text, outputIndex: 0 };
    const response = await this.response;
    if (this.cancelled) throw this.cancelled;
    this.signal?.throwIfAborted();
    yield { type: 'response.completed', response };
  }
}

export interface FakeMcpClientStats {
  connectCalls: number;
  listToolsCalls: number;
  callToolCalls: number;
  closeCalls: number;
}

export function createFakeMcpClient(
  toolCount: number,
  stats: FakeMcpClientStats = {
    connectCalls: 0,
    listToolsCalls: 0,
    callToolCalls: 0,
    closeCalls: 0,
  },
): { client: McpClientLike; stats: FakeMcpClientStats } {
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    name: `tool_${index}`,
    description: `Deterministic fake tool ${index}`,
    inputSchema: { type: 'object' as const, properties: {} },
  }));
  // The production manager owns transport construction. The fake deliberately
  // ignores it, proving catalog behavior without opening a process or socket.
  const client = {
    async connect(): Promise<void> {
      stats.connectCalls += 1;
    },
    async listTools(): Promise<{ tools: typeof tools }> {
      stats.listToolsCalls += 1;
      return { tools };
    },
    async callTool(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
      stats.callToolCalls += 1;
      return { content: [{ type: 'text', text: 'not used by catalog benchmark' }] };
    },
    async close(): Promise<void> {
      stats.closeCalls += 1;
    },
  } as unknown as McpClientLike;
  return { client, stats };
}

function responseFor(model: ResolvedModel, text: string, sequence: number): ModelResponse {
  return Object.freeze({
    id: `benchmark-response-${sequence}`,
    model,
    output: Object.freeze([{ type: 'text' as const, role: 'assistant' as const, text }]),
    finishReason: 'stop' as const,
    usage: BENCH_USAGE,
  });
}

function parseModelRef(ref: ModelRef, defaultProvider: string) {
  if (typeof ref !== 'string') return { providerId: ref.provider, modelId: ref.model };
  const separator = ref.indexOf(':');
  return separator < 0
    ? { providerId: defaultProvider, modelId: ref }
    : { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
}

function isResolved(value: ModelRequest['model']): value is ResolvedModel {
  return typeof value === 'object' && value !== null && 'providerId' in value && 'modelId' in value;
}
