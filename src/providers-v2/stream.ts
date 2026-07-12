import type {
  ModelCallContext,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
} from './types.js';

export interface ModelStreamMapper<TState> {
  readonly state: TState;
  map(event: unknown, state: TState): readonly ModelStreamEvent[];
  finalize(state: TState): ModelResponse;
}

export interface CreateModelStreamOptions<TState> {
  readonly context: ModelCallContext;
  readonly start: (
    context: ModelCallContext,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  readonly mapper: ModelStreamMapper<TState>;
}

/** Single-consumer stream with a lazy capability/transport start. */
export function createModelStream<TState>(
  options: CreateModelStreamOptions<TState>,
): ModelStream {
  return new LazyModelStream(options);
}

class LazyModelStream<TState> implements ModelStream {
  private started = false;
  private settled = false;
  private readonly controller = new AbortController();
  private readonly resultPromise: Promise<ModelResponse>;
  private resolveResult!: (response: ModelResponse) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly abortFromParent: () => void;

  constructor(private readonly options: CreateModelStreamOptions<TState>) {
    this.resultPromise = new Promise<ModelResponse>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // A consumer may observe the iterator error and never call finalResponse().
    this.resultPromise.catch(() => {});

    this.abortFromParent = () => this.controller.abort(options.context.signal?.reason);
    if (options.context.signal?.aborted) {
      this.abortFromParent();
    } else {
      options.context.signal?.addEventListener('abort', this.abortFromParent, { once: true });
    }
  }

  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? createAbortError('Model stream cancelled.'));
    }
  }

  async finalResponse(): Promise<ModelResponse> {
    if (!this.started) {
      for await (const _event of this) {
        // Drain to completion.
      }
    }
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
    if (this.started) {
      throw new Error('Model streams are single-consumer iterables.');
    }
    this.started = true;
    return this.consume()[Symbol.asyncIterator]();
  }

  private async *consume(): AsyncGenerator<ModelStreamEvent> {
    let completedEventEmitted = false;
    let naturallyCompleted = false;
    try {
      throwIfAborted(this.controller.signal);
      const streamContext: ModelCallContext = {
        ...this.options.context,
        signal: this.controller.signal,
      };
      const source = await this.options.start(streamContext);

      for await (const providerEvent of source) {
        throwIfAborted(this.controller.signal);
        const mapped = this.options.mapper.map(providerEvent, this.options.mapper.state);
        for (const event of mapped) {
          if (event.type === 'response.completed') {
            completedEventEmitted = true;
            this.settle(event.response);
          }
          yield event;
        }
      }

      const response = this.options.mapper.finalize(this.options.mapper.state);
      this.settle(response);
      if (!completedEventEmitted) {
        yield { type: 'response.completed', response };
      }
      naturallyCompleted = true;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.options.context.signal?.removeEventListener('abort', this.abortFromParent);
      if (!naturallyCompleted) {
        const reason = this.controller.signal.reason ?? createAbortError('Model stream stopped early.');
        this.cancel(reason);
        if (!this.settled) this.fail(reason);
      }
    }
  }

  private settle(response: ModelResponse): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(response);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectResult(error);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? createAbortError('Model stream aborted.');
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
