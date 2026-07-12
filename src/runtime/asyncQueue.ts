import type { AgentEvent, AgentRunResult } from '../types.js';

type QueueResult<T> = IteratorResult<T>;

export const DEFAULT_ASYNC_QUEUE_CAPACITY = 1_024;
export const DEFAULT_AGENT_RUN_STREAM_BUFFER_CAPACITY = 256;

export type AsyncQueueOverflowStrategy = 'throw' | 'drop-oldest' | 'drop-newest';

export interface AsyncQueueOptions<T> {
  /** Maximum number of values retained in memory. */
  capacity?: number;
  /** Synchronous `push()` behavior when the queue is full. Default: `throw`. */
  overflowStrategy?: AsyncQueueOverflowStrategy;
  /**
   * Safely combine an incoming value with the current tail. Returning
   * `undefined` means that the values cannot be combined.
   */
  coalesce?: (previous: T, incoming: T) => T | undefined;
  /** Identifies values allowed to use `priorityReserve` slots. */
  isPriority?: (value: T) => boolean;
  /** Slots kept free for priority values. */
  priorityReserve?: number;
  /** Restricts which buffered values `drop-oldest` may discard. */
  canDrop?: (value: T) => boolean;
  /** Cancels the entire queue when aborted. */
  signal?: AbortSignal;
}

export interface AsyncQueuePushOptions {
  signal?: AbortSignal;
}

export class AsyncQueueOverflowError extends Error {
  constructor(readonly capacity: number) {
    super(`AsyncQueue reached its capacity of ${capacity}.`);
    this.name = 'AsyncQueueOverflowError';
  }
}

export class AsyncQueueClosedError extends Error {
  constructor() {
    super('AsyncQueue is closed.');
    this.name = 'AsyncQueueClosedError';
  }
}

export class AsyncQueueCancelledError extends Error {
  constructor(reason?: unknown) {
    const detail =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : 'AsyncQueue was cancelled.';
    super(detail, reason instanceof Error ? { cause: reason } : undefined);
    this.name = 'AbortError';
  }
}

interface ConsumerWaiter<T> {
  owner: symbol;
  resolve: (value: QueueResult<T>) => void;
  reject: (error: unknown) => void;
}

interface ProducerWaiter<T> {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('AsyncQueue capacity must be a positive safe integer.');
  }
}

function asAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason;
  }
  return new AsyncQueueCancelledError(reason);
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly consumers: ConsumerWaiter<T>[] = [];
  private readonly producers: ProducerWaiter<T>[] = [];
  private readonly overflowStrategy: AsyncQueueOverflowStrategy;
  private readonly coalesce?: (previous: T, incoming: T) => T | undefined;
  private readonly isPriority: (value: T) => boolean;
  private readonly canDrop: (value: T) => boolean;
  private readonly priorityReserve: number;
  private readonly queueSignal?: AbortSignal;
  private readonly onQueueAbort?: () => void;
  readonly capacity: number;
  private closed = false;
  private failure?: unknown;
  private hasFailure = false;

  constructor(options: AsyncQueueOptions<T> = {}) {
    const capacity = options.capacity ?? DEFAULT_ASYNC_QUEUE_CAPACITY;
    assertCapacity(capacity);
    const priorityReserve = options.priorityReserve ?? 0;
    if (
      !Number.isSafeInteger(priorityReserve)
      || priorityReserve < 0
      || priorityReserve > capacity
    ) {
      throw new RangeError('AsyncQueue priorityReserve must be between 0 and capacity.');
    }

    this.capacity = capacity;
    this.priorityReserve = priorityReserve;
    this.overflowStrategy = options.overflowStrategy ?? 'throw';
    this.coalesce = options.coalesce;
    this.isPriority = options.isPriority ?? (() => false);
    this.canDrop = options.canDrop ?? (() => true);
    this.queueSignal = options.signal;

    if (this.queueSignal?.aborted) {
      this.cancel(this.queueSignal.reason);
    } else if (this.queueSignal) {
      this.onQueueAbort = () => this.cancel(this.queueSignal?.reason);
      this.queueSignal.addEventListener('abort', this.onQueueAbort, { once: true });
    }
  }

  get bufferedSize(): number {
    return this.values.length;
  }

  get pendingConsumerCount(): number {
    return this.consumers.length;
  }

  get pendingProducerCount(): number {
    return this.producers.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Synchronously enqueue a value. This method never grows the buffer beyond
   * `capacity`; use `pushAsync()` when the producer can wait for space.
   *
   * @returns `false` only when `drop-newest` discarded the incoming value.
   */
  push(value: T): boolean {
    this.assertOpen();

    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve({ value, done: false });
      return true;
    }

    if (this.tryCoalesce(value)) {
      return true;
    }

    if (this.canBuffer(value)) {
      this.values.push(value);
      return true;
    }

    if (this.overflowStrategy === 'drop-newest') {
      return false;
    }

    if (this.overflowStrategy === 'drop-oldest') {
      const droppableIndex = this.values.findIndex(
        candidate => !this.isPriority(candidate) && this.canDrop(candidate),
      );
      if (droppableIndex >= 0) {
        this.values.splice(droppableIndex, 1);
        this.values.push(value);
        return true;
      }
    }

    throw new AsyncQueueOverflowError(this.capacity);
  }

  /** Enqueue a value, waiting until a consumer frees capacity when necessary. */
  pushAsync(value: T, options: AsyncQueuePushOptions = {}): Promise<void> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }

    if (options.signal?.aborted) {
      return Promise.reject(asAbortError(options.signal.reason));
    }

    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve({ value, done: false });
      return Promise.resolve();
    }

    if (this.tryCoalesce(value)) {
      return Promise.resolve();
    }

    if (this.canBuffer(value)) {
      this.values.push(value);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: ProducerWaiter<T> = { value, resolve, reject, signal: options.signal };
      if (options.signal) {
        waiter.onAbort = () => {
          if (!this.removeProducer(waiter)) {
            return;
          }
          reject(asAbortError(options.signal?.reason));
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.producers.push(waiter);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachQueueSignal();
    this.rejectAllProducers(new AsyncQueueClosedError());
    while (this.consumers.length > 0) {
      this.consumers.shift()?.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = error;
    this.hasFailure = true;
    this.detachQueueSignal();
    this.rejectAllProducers(error);
    while (this.consumers.length > 0) {
      this.consumers.shift()?.reject(error);
    }
  }

  cancel(reason?: unknown): void {
    const error = asAbortError(reason);
    if (this.closed) {
      this.values.length = 0;
      this.rejectAllProducers(error);
      while (this.consumers.length > 0) {
        this.consumers.shift()?.reject(error);
      }
      return;
    }
    this.closed = true;
    this.failure = error;
    this.hasFailure = true;
    this.values.length = 0;
    this.detachQueueSignal();
    this.rejectAllProducers(error);
    while (this.consumers.length > 0) {
      this.consumers.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const owner = Symbol('AsyncQueue iterator');
    let finished = false;

    return {
      next: async (): Promise<QueueResult<T>> => {
        if (finished) {
          return { value: undefined as never, done: true };
        }
        const result = await this.take(owner);
        if (result.done) {
          finished = true;
        }
        return result;
      },
      return: async (): Promise<QueueResult<T>> => {
        if (!finished) {
          finished = true;
          this.detachConsumer(owner);
        }
        return { value: undefined as never, done: true };
      },
      throw: async (error?: unknown): Promise<QueueResult<T>> => {
        if (!finished) {
          finished = true;
          this.detachConsumer(owner, error, true);
        }
        throw error;
      },
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AsyncQueueClosedError();
    }
  }

  private canBuffer(value: T): boolean {
    const limit = this.isPriority(value)
      ? this.capacity
      : this.capacity - this.priorityReserve;
    return this.values.length < limit;
  }

  private tryCoalesce(value: T): boolean {
    if (!this.coalesce || this.values.length === 0) {
      return false;
    }
    const tailIndex = this.values.length - 1;
    const tail = this.values[tailIndex];
    if (tail === undefined) {
      return false;
    }
    const combined = this.coalesce(tail, value);
    if (combined === undefined) {
      return false;
    }
    this.values[tailIndex] = combined;
    return true;
  }

  private take(owner: symbol): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      this.flushProducers();
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      if (this.hasFailure) {
        return Promise.reject(this.failure);
      }
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<QueueResult<T>>((resolve, reject) => {
      this.consumers.push({ owner, resolve, reject });
    });
  }

  private flushProducers(): void {
    while (!this.closed && this.producers.length > 0) {
      const waiter = this.producers[0];
      if (!waiter) {
        return;
      }
      if (this.tryCoalesce(waiter.value)) {
        this.producers.shift();
        this.resolveProducer(waiter);
        continue;
      }
      if (!this.canBuffer(waiter.value)) {
        return;
      }
      this.producers.shift();
      this.values.push(waiter.value);
      this.resolveProducer(waiter);
    }
  }

  private resolveProducer(waiter: ProducerWaiter<T>): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve();
  }

  private removeProducer(waiter: ProducerWaiter<T>): boolean {
    const index = this.producers.indexOf(waiter);
    if (index < 0) {
      return false;
    }
    this.producers.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    return true;
  }

  private rejectAllProducers(error: unknown): void {
    while (this.producers.length > 0) {
      const waiter = this.producers.shift();
      if (!waiter) {
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(error);
    }
  }

  private detachConsumer(owner: symbol, error?: unknown, reject = false): void {
    for (let index = this.consumers.length - 1; index >= 0; index -= 1) {
      const waiter = this.consumers[index];
      if (waiter?.owner !== owner) {
        continue;
      }
      this.consumers.splice(index, 1);
      if (reject) {
        waiter.reject(error);
      } else {
        waiter.resolve({ value: undefined as never, done: true });
      }
    }
  }

  private detachQueueSignal(): void {
    if (this.queueSignal && this.onQueueAbort) {
      this.queueSignal.removeEventListener('abort', this.onQueueAbort);
    }
  }
}

export interface AgentRunStreamController {
  emit: (event: AgentEvent) => void;
  emitAsync: (event: AgentEvent) => Promise<void>;
  fail: (error: unknown) => void;
  close: () => void;
  readonly signal: AbortSignal;
}

export interface AgentRunStreamOptions {
  /** Total event slots, including one slot reserved for completion/error. */
  maxBufferedEvents?: number;
  /** Default: `throw`. Explicit drop policies may discard non-terminal events. */
  overflowStrategy?: AsyncQueueOverflowStrategy;
  /** Coalesce adjacent buffered text/thinking/tool-input deltas. Default: true. */
  coalesceDeltas?: boolean;
  /** Cancels the stream and its executor controller when aborted. */
  signal?: AbortSignal;
}

function isTerminalAgentEvent(event: AgentEvent): boolean {
  return event.type === 'response.completed' || event.type === 'error';
}

function coalesceAgentDelta(previous: AgentEvent, incoming: AgentEvent): AgentEvent | undefined {
  if (previous.type !== incoming.type) {
    return undefined;
  }
  if (
    previous.type === 'response.text.delta'
    && incoming.type === 'response.text.delta'
    && previous.runId === incoming.runId
    && previous.iteration === incoming.iteration
  ) {
    return { ...incoming, delta: previous.delta + incoming.delta };
  }
  if (
    previous.type === 'response.thinking.delta'
    && incoming.type === 'response.thinking.delta'
    && previous.runId === incoming.runId
    && previous.iteration === incoming.iteration
    && previous.index === incoming.index
  ) {
    return {
      ...incoming,
      delta: previous.delta + incoming.delta,
      signature: incoming.signature ?? previous.signature,
    };
  }
  if (
    previous.type === 'response.tool_input.delta'
    && incoming.type === 'response.tool_input.delta'
    && previous.runId === incoming.runId
    && previous.iteration === incoming.iteration
    && previous.index === incoming.index
    && previous.toolUseId === incoming.toolUseId
    && previous.toolName === incoming.toolName
  ) {
    return { ...incoming, delta: previous.delta + incoming.delta };
  }
  return undefined;
}

export class AgentRunStream implements AsyncIterable<AgentEvent> {
  private readonly queue: AsyncQueue<AgentEvent>;
  private readonly abortController = new AbortController();
  private readonly externalSignal?: AbortSignal;
  private readonly onExternalAbort?: () => void;
  readonly result: Promise<AgentRunResult>;

  constructor(
    executor: (controller: AgentRunStreamController) => Promise<AgentRunResult>,
    options: AgentRunStreamOptions = {},
  ) {
    const capacity = options.maxBufferedEvents ?? DEFAULT_AGENT_RUN_STREAM_BUFFER_CAPACITY;
    assertCapacity(capacity);
    if (capacity < 2) {
      throw new RangeError('AgentRunStream maxBufferedEvents must be at least 2.');
    }

    const queue = new AsyncQueue<AgentEvent>({
      capacity,
      overflowStrategy: options.overflowStrategy,
      coalesce: options.coalesceDeltas === false ? undefined : coalesceAgentDelta,
      isPriority: isTerminalAgentEvent,
      priorityReserve: 1,
    });
    this.queue = queue;
    this.externalSignal = options.signal;
    if (this.externalSignal?.aborted) {
      this.cancelWithReason(this.externalSignal.reason);
    } else if (this.externalSignal) {
      this.onExternalAbort = () => this.cancelWithReason(this.externalSignal?.reason);
      this.externalSignal.addEventListener('abort', this.onExternalAbort, { once: true });
    }

    this.result = (async () => {
      try {
        return await executor({
          emit: event => {
            queue.push(event);
          },
          emitAsync: event => queue.pushAsync(event, { signal: this.abortController.signal }),
          fail: error => queue.fail(error),
          close: () => queue.close(),
          signal: this.abortController.signal,
        });
      } catch (error) {
        queue.fail(error);
        throw error;
      } finally {
        queue.close();
        this.detachExternalSignal();
      }
    })();

    // Preserve result rejection for callers while preventing an abandoned
    // stream from becoming a process-level unhandled rejection.
    void this.result.catch(() => undefined);
  }

  get bufferedEventCount(): number {
    return this.queue.bufferedSize;
  }

  get pendingConsumerCount(): number {
    return this.queue.pendingConsumerCount;
  }

  get pendingProducerCount(): number {
    return this.queue.pendingProducerCount;
  }

  get isCancelled(): boolean {
    return this.abortController.signal.aborted;
  }

  cancel(reason?: string): void {
    this.cancelWithReason(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const iterator = this.queue[Symbol.asyncIterator]();
    let returned = false;
    return {
      next: () => iterator.next(),
      return: async (): Promise<QueueResult<AgentEvent>> => {
        if (!returned) {
          returned = true;
          await iterator.return?.();
          this.cancel('AgentRunStream consumer stopped before completion.');
        }
        return { value: undefined as never, done: true };
      },
      throw: async (error?: unknown): Promise<QueueResult<AgentEvent>> => {
        if (!returned) {
          returned = true;
          await iterator.return?.();
          this.cancelWithReason(error);
        }
        throw error;
      },
    };
  }

  private cancelWithReason(reason?: unknown): void {
    if (this.abortController.signal.aborted) {
      return;
    }
    const error = asAbortError(reason);
    this.abortController.abort(error);
    this.queue.cancel(error);
    this.detachExternalSignal();
  }

  private detachExternalSignal(): void {
    if (this.externalSignal && this.onExternalAbort) {
      this.externalSignal.removeEventListener('abort', this.onExternalAbort);
    }
  }
}
