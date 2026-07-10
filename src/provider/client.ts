import type {
  ContentBlockDeltaEvent,
  ContentBlockStartEvent,
  ContentBlockStopEvent,
  ContentBlock,
  Message,
  MessageDeltaEvent,
  MessageParam,
  MessageStreamEvent,
  Metadata,
  Tool,
  ToolChoice,
  Usage,
} from './types.js';
import { ActoviqProviderApiError } from '../errors.js';
import { robustJsonParse } from './json-parse.js';

export interface ActoviqProviderClientOptions {
  apiKey?: string | null;
  authToken?: string | null;
  baseURL?: string | null;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export interface ActoviqCreateMessageRequest {
  model: string;
  messages: MessageParam[];
  max_tokens: number;
  system?: string | unknown[];
  temperature?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  metadata?: Metadata;
  stop_sequences?: string[];
  extra_tool_schemas?: Record<string, unknown>[];
  output_config?: Record<string, unknown>;
}

export interface ActoviqRequestOptions {
  signal?: AbortSignal;
  betas?: string[];
}

interface ApiErrorShape {
  error?: {
    message?: string;
    type?: string;
  };
  message?: string;
}

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMessagesUrl(baseURL?: string | null): string {
  const normalized = (baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
  if (/\/v1\/messages$/iu.test(normalized)) {
    return normalized;
  }
  if (/\/v1$/iu.test(normalized)) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTimeoutSignal(timeoutMs: number | undefined, signal?: AbortSignal): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  if (typeof timeout === 'object') {
    timeout.unref?.();
  }
  const abortFromParent = () => controller.abort(signal?.reason);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      abortFromParent();
    } else {
      signal.addEventListener('abort', abortFromParent, { once: true });
      controller.signal.addEventListener(
        'abort',
        () => signal.removeEventListener('abort', abortFromParent),
        { once: true },
      );
    }
  }

  controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
  return controller.signal;
}

async function safeReadJson(response: Response): Promise<ApiErrorShape | undefined> {
  try {
    return (await response.json()) as ApiErrorShape;
  } catch {
    return undefined;
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function createErrorMessage(status: number, payload?: ApiErrorShape, fallbackText?: string): string {
  const message =
    payload?.error?.message ??
    payload?.message ??
    fallbackText?.trim() ??
    `Provider request failed with HTTP ${status}.`;
  return `Provider request failed with HTTP ${status}: ${message}`;
}

function normalizeMessage(payload: unknown): Message {
  if (!isRecord(payload)) {
    throw new Error('Provider response did not contain a valid message payload.');
  }
  const content = Array.isArray(payload.content) ? (payload.content as ContentBlock[]) : [];
  return {
    id: typeof payload.id === 'string' ? payload.id : 'msg_unknown',
    type: 'message',
    role: 'assistant',
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    content,
    stop_reason:
      typeof payload.stop_reason === 'string' || payload.stop_reason === null
        ? (payload.stop_reason as Message['stop_reason'])
        : null,
    stop_sequence:
      typeof payload.stop_sequence === 'string' || payload.stop_sequence === null
        ? (payload.stop_sequence as string | null)
        : null,
    usage: isRecord(payload.usage) ? (payload.usage as Usage) : undefined,
    ...payload,
  };
}

class MessageAccumulator {
  private message: Message | undefined;
  private readonly pendingJsonByIndex = new Map<number, string>();

  apply(event: MessageStreamEvent): void {
    if (event.type === 'message_start' && isRecord(event.message)) {
      this.message = normalizeMessage(event.message);
      if (!Array.isArray(this.message.content)) {
        this.message.content = [];
      }
      return;
    }

    if (isContentBlockStartEvent(event)) {
      this.ensureMessage();
      this.message!.content[event.index] = structuredClone(event.content_block);
      return;
    }

    if (isContentBlockDeltaEvent(event)) {
      this.ensureMessage();
      this.applyContentDelta(event.index, event.delta);
      return;
    }

    if (isContentBlockStopEvent(event)) {
      this.ensureMessage();
      this.flushPendingJson(event.index);
      return;
    }

    if (isMessageDeltaEvent(event)) {
      this.ensureMessage();
      if (event.delta && isRecord(event.delta)) {
        if ('stop_reason' in event.delta) {
          this.message!.stop_reason = (event.delta.stop_reason ?? null) as Message['stop_reason'];
        }
        if ('stop_sequence' in event.delta) {
          this.message!.stop_sequence = (event.delta.stop_sequence ?? null) as string | null;
        }
      }
      if (event.usage && isRecord(event.usage)) {
        this.message!.usage = event.usage as Usage;
      }
    }
  }

  finalize(): Message {
    if (!this.message) {
      throw new Error('The provider stream ended without a final message.');
    }

    for (const index of this.pendingJsonByIndex.keys()) {
      this.flushPendingJson(index);
    }

    return this.message;
  }

  private ensureMessage(): void {
    if (!this.message) {
      this.message = {
        id: 'msg_stream',
        type: 'message',
        role: 'assistant',
        model: 'unknown',
        content: [],
        stop_reason: null,
        stop_sequence: null,
      };
    }
  }

  private applyContentDelta(index: number, delta: ContentBlockDeltaEvent['delta']): void {
    const block = this.message!.content[index];
    if (!isRecord(block) || !isRecord(delta) || typeof delta.type !== 'string') {
      return;
    }

    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      const existing = typeof block.text === 'string' ? block.text : '';
      block.text = `${existing}${delta.text}`;
      return;
    }

    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const existing = typeof block.thinking === 'string' ? block.thinking : '';
      block.thinking = `${existing}${delta.thinking}`;
      if (typeof delta.signature === 'string') {
        block.signature = delta.signature;
      }
      return;
    }

    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const current = this.pendingJsonByIndex.get(index) ?? '';
      this.pendingJsonByIndex.set(index, `${current}${delta.partial_json}`);
    }
  }

  private flushPendingJson(index: number): void {
    const block = this.message?.content[index];
    const pending = this.pendingJsonByIndex.get(index);
    if (!isRecord(block) || typeof pending !== 'string' || pending.length === 0) {
      this.pendingJsonByIndex.delete(index);
      return;
    }

    block.input = robustJsonParse(pending, block.name as string | undefined);

    // Debug: log when tool input appears to have been fallback-wrapped
    if (
      process.env.ACTOVIQ_DEBUG_JSON &&
      isRecord(block.input) &&
      'raw' in block.input &&
      Object.keys(block.input).length === 1
    ) {
      const rawLen = typeof block.input.raw === 'string' ? block.input.raw.length : 0;
      console.error(`\n[tool_use parse] name=${block.name ?? '?'} pendingLen=${pending.length} resultKeys=[raw] rawLen=${rawLen} pendingStart=${pending.slice(0, 100)}`);
    }

    this.pendingJsonByIndex.delete(index);
  }
}

class ActoviqProviderMessageStream implements AsyncIterable<MessageStreamEvent> {
  private started = false;
  private finished = false;
  private readonly accumulator = new MessageAccumulator();
  private readonly finalMessagePromise: Promise<Message>;
  private resolveFinalMessage!: (message: Message) => void;
  private rejectFinalMessage!: (error: unknown) => void;

  constructor(
    private readonly responsePromise: Promise<Response>,
  ) {
    this.finalMessagePromise = new Promise<Message>((resolve, reject) => {
      this.resolveFinalMessage = resolve;
      this.rejectFinalMessage = reject;
    });
    // If the stream iterator throws (e.g. mid-stream socket loss), callers see
    // the iterator error and usually never await finalMessage(); without this
    // detached handler the rejection is unhandled and kills the process.
    this.finalMessagePromise.catch(() => {});
  }

  async finalMessage(): Promise<Message> {
    if (!this.started && !this.finished) {
      for await (const _event of this) {
        // Drain the stream to materialize the final message.
      }
    }
    return this.finalMessagePromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    if (this.started) {
      throw new Error('This provider stream has already been consumed.');
    }
    this.started = true;

    try {
      const response = await this.responsePromise;
      if (!response.body) {
        throw new Error('The provider returned a stream response without a body.');
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = '';
      let currentEventName = 'message';
      let dataLines: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split(/\r?\n/u);
        buffer = segments.pop() ?? '';

        for (const segment of segments) {
          if (segment === '') {
            const event = parseSsePayload(currentEventName, dataLines);
            currentEventName = 'message';
            dataLines = [];
            if (!event) {
              continue;
            }
            this.accumulator.apply(event);
            yield event;
            continue;
          }

          if (segment.startsWith('event:')) {
            currentEventName = segment.slice('event:'.length).trim();
            continue;
          }

          if (segment.startsWith('data:')) {
            dataLines.push(segment.slice('data:'.length).trimStart());
          }
        }
      }

      const trailingEvent = parseSsePayload(currentEventName, dataLines);
      if (trailingEvent) {
        this.accumulator.apply(trailingEvent);
        yield trailingEvent;
      }

      const finalMessage = this.accumulator.finalize();
      this.finished = true;
      this.resolveFinalMessage(finalMessage);
    } catch (error) {
      this.finished = true;
      this.rejectFinalMessage(error);
      throw error;
    }
  }
}

function parseSsePayload(
  eventName: string,
  dataLines: string[],
): MessageStreamEvent | undefined {
  if (dataLines.length === 0) {
    return undefined;
  }

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') {
    return { type: 'message_stop' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  return {
    ...parsed,
    type: typeof parsed.type === 'string' ? parsed.type : eventName,
  } as MessageStreamEvent;
}

function isContentBlockStartEvent(event: MessageStreamEvent): event is ContentBlockStartEvent {
  return (
    event.type === 'content_block_start' &&
    typeof (event as { index?: unknown }).index === 'number' &&
    isRecord((event as { content_block?: unknown }).content_block)
  );
}

function isContentBlockDeltaEvent(event: MessageStreamEvent): event is ContentBlockDeltaEvent {
  return (
    event.type === 'content_block_delta' &&
    typeof (event as { index?: unknown }).index === 'number' &&
    isRecord((event as { delta?: unknown }).delta)
  );
}

function isContentBlockStopEvent(event: MessageStreamEvent): event is ContentBlockStopEvent {
  return event.type === 'content_block_stop' && typeof (event as { index?: unknown }).index === 'number';
}

function isMessageDeltaEvent(event: MessageStreamEvent): event is MessageDeltaEvent {
  return event.type === 'message_delta';
}

export default class ActoviqProviderClient {
  readonly messages = {
    create: (body: ActoviqCreateMessageRequest, options?: ActoviqRequestOptions) =>
      this.createMessage(body, options),
    stream: (body: ActoviqCreateMessageRequest, options?: ActoviqRequestOptions) =>
      this.streamMessage(body, options),
  };

  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs?: number;
  private readonly apiKey?: string | null;
  private readonly authToken?: string | null;
  private readonly baseURL?: string | null;

  constructor(options: ActoviqProviderClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeout;
    this.apiKey = options.apiKey ?? null;
    this.authToken = options.authToken ?? null;
    this.baseURL = options.baseURL ?? null;
  }

  async createMessage(
    body: ActoviqCreateMessageRequest,
    options?: ActoviqRequestOptions,
  ): Promise<Message> {
    const response = await this.sendRequest(
      {
        ...body,
        stream: false,
      },
      options,
    );
    return normalizeMessage(await response.json());
  }

  streamMessage(
    body: ActoviqCreateMessageRequest,
    options?: ActoviqRequestOptions,
  ): ActoviqProviderMessageStream {
    return new ActoviqProviderMessageStream(
      this.sendRequest(
        {
          ...body,
          stream: true,
        },
        options,
      ),
    );
  }

  private async sendRequest(
    body: Record<string, unknown>,
    options?: ActoviqRequestOptions,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const requestSignal = makeTimeoutSignal(this.timeoutMs, options?.signal);
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchImpl(normalizeMessagesUrl(this.baseURL), {
          method: 'POST',
          headers: this.buildHeaders(body.stream === true, options?.betas),
          body: JSON.stringify(body),
          signal: requestSignal,
        });

        if (response.ok) {
          return response;
        }

        const payload = await safeReadJson(response.clone());
        const fallbackText = payload ? undefined : await safeReadText(response.clone());
        const error = new ActoviqProviderApiError(
          createErrorMessage(response.status, payload, fallbackText),
          {
            status: response.status,
            errorType:
              payload?.error?.type ??
              (typeof payload?.error === 'object' ? undefined : undefined),
          },
        );
        if (!shouldRetryStatus(response.status) || attempt === this.maxRetries) {
          throw error;
        }
        retryAfterMs = parseRetryAfterMs(response);
        lastError = error;
      } catch (error) {
        lastError = error;
        const retryable = shouldRetryError(error);
        if (attempt === this.maxRetries || !retryable) {
          throw retryable ? normalizeTransportError(error, normalizeMessagesUrl(this.baseURL)) : error;
        }
      }

      await delay(computeRetryDelayMs(attempt, retryAfterMs));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('The provider request failed unexpectedly.');
  }

  private buildHeaders(streaming: boolean, betas?: string[]): HeadersInit {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
    };

    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    } else if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    if (betas && betas.length > 0) {
      headers['anthropic-beta'] = [...new Set(betas)].join(',');
    }

    return headers;
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const MAX_RETRY_AFTER_MS = 30_000;

/** Honor server-provided Retry-After when rate limited or overloaded. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const retryAfterMsHeader = response.headers.get('retry-after-ms');
  if (retryAfterMsHeader) {
    const parsed = Number.parseFloat(retryAfterMsHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, MAX_RETRY_AFTER_MS);
    }
  }
  const retryAfterHeader = response.headers.get('retry-after');
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
  }
  return undefined;
}

export function computeRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  // Exponential backoff capped at 30s with +/-25% jitter to avoid
  // synchronized retry storms across parallel runs (Claude Code-style).
  const backoff = Math.min(500 * 2 ** attempt, 30_000);
  const jittered = Math.round(backoff * (0.75 + Math.random() * 0.5));
  if (retryAfterMs === undefined) {
    return jittered;
  }
  return Math.max(jittered, retryAfterMs);
}

function shouldRetryError(error: unknown): boolean {
  if (error instanceof ActoviqProviderApiError) {
    return false;
  }
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return false;
  }
  return isTransientTransportError(error);
}

function isTransientTransportError(error: Error): boolean {
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const text = `${error.name} ${error.message} ${cause?.name ?? ''} ${cause?.message ?? ''} ${
    cause && 'code' in cause ? String((cause as { code?: unknown }).code) : ''
  }`.toLowerCase();
  return (
    error instanceof TypeError ||
    text.includes('terminated') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('und_err_socket') ||
    text.includes('socket') ||
    text.includes('fetch failed') ||
    text.includes('network')
  );
}

function normalizeTransportError(error: unknown, url: string): unknown {
  if (!(error instanceof Error) || !isTransientTransportError(error)) {
    return error;
  }
  return new ActoviqProviderApiError(
    `Provider transport error after retries: ${error.message} [url: ${url}]`,
    {
      status: 0,
      errorType: 'transport_error',
      cause: error,
    },
  );
}
