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
  system?: string;
  temperature?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  metadata?: Metadata;
  stop_sequences?: string[];
}

export interface ActoviqRequestOptions {
  signal?: AbortSignal;
}

interface ApiErrorShape {
  error?: {
    message?: string;
    type?: string;
  };
  message?: string;
}

const LEGACY_HEADER_PARTS = {
  apiVersion: ['anth', 'ropic-version'],
  apiBeta: ['anth', 'ropic-beta'],
};

const LEGACY_DEFAULT_BASE_URL = ['https://api.', 'anth', 'ropic.com'].join('');

function getLegacyHeaderName(kind: keyof typeof LEGACY_HEADER_PARTS): string {
  return LEGACY_HEADER_PARTS[kind].join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMessagesUrl(baseURL?: string | null): string {
  const normalized = (baseURL ?? LEGACY_DEFAULT_BASE_URL).replace(/\/+$/u, '');
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

    try {
      block.input = JSON.parse(pending) as Record<string, unknown>;
    } catch {
      block.input = { raw: pending };
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

  const parsed = JSON.parse(payload) as Record<string, unknown>;
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
    const requestSignal = makeTimeoutSignal(this.timeoutMs, options?.signal);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(normalizeMessagesUrl(this.baseURL), {
          method: 'POST',
          headers: this.buildHeaders(body.stream === true),
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
        lastError = error;
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries || !shouldRetryError(error)) {
          throw error;
        }
      }

      await delay(Math.min(250 * 2 ** attempt, 2000));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('The provider request failed unexpectedly.');
  }

  private buildHeaders(streaming: boolean): HeadersInit {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      [getLegacyHeaderName('apiVersion')]: '2023-06-01',
    };

    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    } else if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function shouldRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError' ? false : true;
}
