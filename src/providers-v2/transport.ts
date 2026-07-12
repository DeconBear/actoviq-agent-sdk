import type {
  ModelCallContext,
  ProviderTransport,
  ProviderTransportRequest,
} from './types.js';

export class ProviderTransportError extends Error {
  readonly code = 'PROVIDER_TRANSPORT_ERROR';

  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderTransportError';
  }
}

export interface FetchProviderTransportOptions {
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Generic JSON/SSE transport. It retries only while establishing a request;
 * once a stream yields an event it is never replayed.
 */
export class FetchProviderTransport implements ProviderTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs?: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: FetchProviderTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.timeoutMs = options.timeoutMs;
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.maxRetryDelayMs = Math.max(this.retryBaseDelayMs, options.maxRetryDelayMs ?? 30_000);
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableDelay;
  }

  async request(
    request: ProviderTransportRequest,
    context: ModelCallContext,
  ): Promise<unknown> {
    const opened = await this.open(request, context, false);
    try {
      return await opened.response.json();
    } catch (error) {
      throw new ProviderTransportError(
        `Provider ${request.providerId} returned invalid JSON.`,
        opened.response.status,
        false,
        { cause: error },
      );
    } finally {
      opened.cleanup();
    }
  }

  stream(
    request: ProviderTransportRequest,
    context: ModelCallContext,
  ): AsyncIterable<unknown> {
    return this.readEventStream(request, context);
  }

  private async *readEventStream(
    request: ProviderTransportRequest,
    context: ModelCallContext,
  ): AsyncGenerator<unknown> {
    const opened = await this.open(request, context, true);
    const { response } = opened;
    if (!response.body) {
      opened.cleanup();
      throw new ProviderTransportError(
        `Provider ${request.providerId} returned a stream without a response body.`,
        response.status,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // Some compatible endpoints return a single JSON response even with stream=true.
      try {
        yield await response.json();
        return;
      } finally {
        opened.cleanup();
      }
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let eventName = 'message';
    let dataLines: string[] = [];

    try {
      while (true) {
        throwIfAborted(opened.signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            const event = parseSseEvent(eventName, dataLines);
            eventName = 'message';
            dataLines = [];
            if (event !== undefined) yield event;
          } else if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          }
        }
      }

      if (buffer.length > 0) {
        if (buffer.startsWith('event:')) eventName = buffer.slice('event:'.length).trim();
        else if (buffer.startsWith('data:')) dataLines.push(buffer.slice('data:'.length).trimStart());
      }
      const trailing = parseSseEvent(eventName, dataLines);
      if (trailing !== undefined) yield trailing;
    } finally {
      reader.releaseLock();
      opened.cleanup();
    }
  }

  private async open(
    request: ProviderTransportRequest,
    context: ModelCallContext,
    streaming: boolean,
  ): Promise<OpenedResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      throwIfAborted(context.signal);
      if (context.deadline !== undefined && context.deadline <= Date.now()) {
        throw createAbortError('Model call deadline exceeded.');
      }
      const scoped = createScopedSignal(context, this.timeoutMs);
      try {
        const response = await this.fetchImpl(request.url, {
          method: request.method,
          headers: {
            ...request.headers,
            accept: streaming ? 'text/event-stream' : 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(request.body),
          signal: scoped.signal,
        });

        if (response.ok) {
          return {
            response,
            signal: scoped.signal,
            cleanup: scoped.cleanup,
          };
        }

        const message = await responseErrorMessage(response, request.providerId);
        const retryable = isRetryableStatus(response.status);
        const error = new ProviderTransportError(message, response.status, retryable);
        if (!retryable || attempt === this.maxRetries) {
          throw error;
        }
        lastError = error;
        const retryAfterMs = parseRetryAfter(response.headers);
        scoped.cleanup();
        await this.sleep(this.retryDelay(attempt, retryAfterMs), context.signal);
      } catch (error) {
        scoped.cleanup();
        if (isAbortError(error) || context.signal?.aborted) {
          throw abortReason(context.signal, error);
        }
        if (error instanceof ProviderTransportError && !error.retryable) {
          throw error;
        }
        const retryable = isRetryableTransportError(error);
        if (!retryable || attempt === this.maxRetries) {
          if (error instanceof ProviderTransportError) throw error;
          throw new ProviderTransportError(
            `Provider ${request.providerId} transport failed: ${errorMessage(error)}.`,
            undefined,
            retryable,
            { cause: error },
          );
        }
        lastError = error;
        await this.sleep(this.retryDelay(attempt), context.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderTransportError(`Provider ${request.providerId} transport failed.`);
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    const exponential = Math.min(
      this.retryBaseDelayMs * 2 ** attempt,
      this.maxRetryDelayMs,
    );
    const jittered = Math.round(exponential * (0.75 + this.random() * 0.5));
    return Math.min(this.maxRetryDelayMs, Math.max(jittered, retryAfterMs ?? 0));
  }
}

interface OpenedResponse {
  readonly response: Response;
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
}

function parseSseEvent(eventName: string, dataLines: readonly string[]): unknown {
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return { type: 'done' };
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      !('type' in parsed)
    ) {
      return { ...(parsed as Record<string, unknown>), type: eventName };
    }
    return parsed;
  } catch {
    return { type: eventName, data };
  }
}

async function responseErrorMessage(response: Response, providerId: string): Promise<string> {
  let providerMessage: string | undefined;
  try {
    const body = await response.clone().json() as Record<string, unknown>;
    const error = body.error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') providerMessage = message;
    } else if (typeof body.message === 'string') {
      providerMessage = body.message;
    }
  } catch {
    // Error bodies are diagnostic only and must not mask the status code.
  }
  return `Provider ${providerId} request failed with HTTP ${response.status}${
    providerMessage ? `: ${providerMessage}` : ''
  }.`;
}

function createScopedSignal(
  context: ModelCallContext,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  const remaining = context.deadline === undefined
    ? undefined
    : Math.max(0, context.deadline - Date.now());
  const effectiveTimeout = [timeoutMs, remaining]
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((minimum, value) => minimum === undefined ? value : Math.min(minimum, value), undefined);

  if (effectiveTimeout === undefined && !context.signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(context.signal?.reason);
  if (context.signal) {
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener('abort', abortFromParent, { once: true });
  }
  if (effectiveTimeout !== undefined) {
    if (effectiveTimeout <= 0) {
      controller.abort(createAbortError('Model call deadline exceeded.'));
    } else {
      timer = setTimeout(
        () => controller.abort(createAbortError('Model call deadline exceeded.')),
        effectiveTimeout,
      );
      timer.unref?.();
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function parseRetryAfter(headers: Headers): number | undefined {
  const milliseconds = Number.parseFloat(headers.get('retry-after-ms') ?? '');
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;

  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof ProviderTransportError) return error.retryable;
  if (!(error instanceof Error)) return false;
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const text = `${error.name} ${error.message} ${cause?.name ?? ''} ${cause?.message ?? ''} ${
    cause && 'code' in cause ? String((cause as { code?: unknown }).code) : ''
  }`.toLowerCase();
  return (
    error instanceof TypeError ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('socket') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('terminated')
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal | undefined, fallback: unknown): unknown {
  return signal?.aborted
    ? signal.reason ?? createAbortError('Model call aborted.')
    : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? createAbortError('Model call aborted.');
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? createAbortError('Model call aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return;
        onAbort();
      });
    }
  });
}
