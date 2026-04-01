import type { AgentEvent, AgentRunResult } from '../types.js';

type QueueResult<T> = IteratorResult<T>;

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<(value: QueueResult<T>) => void> = [];
  private readonly rejecters: Array<(error: unknown) => void> = [];
  private closed = false;
  private failure?: unknown;

  push(value: T): void {
    if (this.closed) {
      throw new Error('AsyncQueue is closed.');
    }
    const resolve = this.resolvers.shift();
    this.rejecters.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      this.rejecters.shift();
      resolve?.({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = error;
    while (this.rejecters.length > 0) {
      const reject = this.rejecters.shift();
      this.resolvers.shift();
      reject?.(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<QueueResult<T>> => {
        if (this.values.length > 0) {
          return { value: this.values.shift() as T, done: false };
        }
        if (this.closed) {
          if (this.failure !== undefined) {
            throw this.failure;
          }
          return { value: undefined as never, done: true };
        }
        return new Promise<QueueResult<T>>((resolve, reject) => {
          this.resolvers.push(resolve);
          this.rejecters.push(reject);
        });
      },
    };
  }
}

export class AgentRunStream implements AsyncIterable<AgentEvent> {
  private readonly queue = new AsyncQueue<AgentEvent>();
  readonly result: Promise<AgentRunResult>;

  constructor(
    executor: (controller: {
      emit: (event: AgentEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    }) => Promise<AgentRunResult>,
  ) {
    this.result = (async () => {
      try {
        return await executor({
          emit: (event) => this.queue.push(event),
          fail: (error) => this.queue.fail(error),
          close: () => this.queue.close(),
        });
      } catch (error) {
        this.queue.fail(error);
        throw error;
      } finally {
        this.queue.close();
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}
