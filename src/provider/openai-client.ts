import type {
  OpenaiChatCompletion,
  OpenaiChatCompletionChunk,
  OpenaiChatCompletionRequest,
} from './openai-types.js';
import { ActoviqProviderApiError } from '../errors.js';
import { computeRetryDelayMs, parseRetryAfterMs } from './client.js';

export interface OpenaiProviderClientOptions {
  apiKey?: string | null;
  authToken?: string | null;
  baseURL?: string | null;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

interface ApiErrorShape {
  error?: { message?: string; type?: string; code?: string };
  message?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

function normalizeChatUrl(baseURL?: string | null): string {
  const normalized = (baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
  if (/\/v1\/chat\/completions$/iu.test(normalized)) {
    return normalized;
  }
  if (/\/v1$/iu.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTimeoutSignal(
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Request timed out.')),
    timeoutMs,
  );
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

function createErrorMessage(status: number, payload?: ApiErrorShape): string {
  const msg =
    payload?.error?.message ?? payload?.message ?? `Provider request failed with HTTP ${status}.`;
  return `Provider request failed with HTTP ${status}: ${msg}`;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
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

// ── SSE Stream ─────────────────────────────────────────────────

export class OpenaiProviderMessageStream
  implements AsyncIterable<OpenaiChatCompletionChunk>
{
  private started = false;
  private finished = false;
  private chunks: OpenaiChatCompletionChunk[] = [];
  private finalMessagePromise: Promise<OpenaiChatCompletion>;
  private resolveFinal!: (msg: OpenaiChatCompletion) => void;
  private rejectFinal!: (err: unknown) => void;

  constructor(private readonly responsePromise: Promise<Response>) {
    this.finalMessagePromise = new Promise<OpenaiChatCompletion>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  async finalMessage(): Promise<OpenaiChatCompletion> {
    if (!this.started && !this.finished) {
      for await (const _ of this) {
        // drain
      }
    }
    return this.finalMessagePromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<OpenaiChatCompletionChunk> {
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split(/\r?\n/u);
        buffer = segments.pop() ?? '';

        for (const segment of segments) {
          if (!segment.startsWith('data:')) continue;
          const data = segment.slice('data:'.length).trimStart();
          if (data === '[DONE]') {
            this.finished = true;
            const assembled = this.assembleCompletion();
            this.resolveFinal(assembled);
            return;
          }
          try {
            const chunk = JSON.parse(data) as OpenaiChatCompletionChunk;
            this.chunks.push(chunk);
            yield chunk;
          } catch {
            // skip unparseable lines
          }
        }
      }

      // Stream ended without [DONE] — assemble what we have
      this.finished = true;
      const assembled = this.assembleCompletion();
      this.resolveFinal(assembled);
    } catch (error) {
      this.finished = true;
      this.rejectFinal(error);
      throw error;
    }
  }

  private assembleCompletion(): OpenaiChatCompletion {
    if (this.chunks.length === 0) {
      return {
        id: 'chatcmpl_unknown',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'unknown',
        choices: [],
      };
    }

    const first = this.chunks[0];
    const choiceMap = new Map<number, { role: string; content: string; toolCalls: Map<number, { id: string; name: string; args: string }>; finish_reason: string | null }>();

    for (const chunk of this.chunks) {
      for (const choice of chunk.choices) {
        if (!choiceMap.has(choice.index)) {
          choiceMap.set(choice.index, {
            role: choice.delta.role ?? '',
            content: '',
            toolCalls: new Map(),
            finish_reason: null,
          });
        }
        const acc = choiceMap.get(choice.index)!;
        if (choice.delta.content) {
          acc.content += choice.delta.content;
        }
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
        if (choice.finish_reason) {
          acc.finish_reason = choice.finish_reason;
        }
      }
    }

    // Use the last chunk's usage if available
    const lastWithUsage = [...this.chunks].reverse().find((c) => c.usage);
    const usage = lastWithUsage?.usage;

    return {
      id: first?.id ?? 'chatcmpl_unknown',
      object: 'chat.completion' as const,
      created: first?.created ?? Math.floor(Date.now() / 1000),
      model: first?.model ?? 'unknown',
      usage,
      choices: [...choiceMap.entries()].map(([index, acc]) => ({
        index,
        message: {
          role: (acc.role || 'assistant') as 'assistant',
          content: acc.content || null,
          tool_calls:
            acc.toolCalls.size > 0
              ? [...acc.toolCalls.entries()].map(([, tc]) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: tc.args,
                  },
                }))
              : undefined,
        },
        finish_reason: acc.finish_reason,
      })),
    };
  }
}

// ── HTTP Client ────────────────────────────────────────────────

export default class OpenaiProviderClient {
  readonly chat = {
    completions: {
      create: (body: OpenaiChatCompletionRequest, signal?: AbortSignal) =>
        this.createCompletion(body, signal),
      stream: (body: OpenaiChatCompletionRequest, signal?: AbortSignal) =>
        this.streamCompletion(body, signal),
    },
  };

  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs?: number;
  private readonly apiKey?: string | null;
  private readonly authToken?: string | null;
  private readonly baseURL?: string | null;

  constructor(options: OpenaiProviderClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeout;
    this.apiKey = options.apiKey ?? null;
    this.authToken = options.authToken ?? null;
    this.baseURL = options.baseURL ?? null;
  }

  async createCompletion(
    body: OpenaiChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenaiChatCompletion> {
    const response = await this.sendRequest({ ...body, stream: false }, signal);
    return (await response.json()) as OpenaiChatCompletion;
  }

  streamCompletion(
    body: OpenaiChatCompletionRequest,
    signal?: AbortSignal,
  ): OpenaiProviderMessageStream {
    return new OpenaiProviderMessageStream(
      this.sendRequest({ ...body, stream: true }, signal),
    );
  }

  private async sendRequest(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const requestSignal = makeTimeoutSignal(this.timeoutMs, signal);
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchImpl(normalizeChatUrl(this.baseURL), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: requestSignal,
        });

        if (response.ok) return response;

        const payload = await safeReadJson(response.clone());
        const url = normalizeChatUrl(this.baseURL);
        const error = new ActoviqProviderApiError(
          `${createErrorMessage(response.status, payload)} [url: ${url}]`,
          {
            status: response.status,
            errorType: payload?.error?.type,
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
          throw retryable ? normalizeTransportError(error, normalizeChatUrl(this.baseURL)) : error;
        }
      }

      await delay(computeRetryDelayMs(attempt, retryAfterMs));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('The provider request failed unexpectedly.');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };

    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    } else if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}
