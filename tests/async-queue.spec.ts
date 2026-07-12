import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult } from '../src/types.js';
import {
  AgentRunStream,
  AsyncQueue,
  AsyncQueueOverflowError,
} from '../src/runtime/asyncQueue.js';

function createRunResult(text = 'done'): AgentRunResult {
  return {
    runId: 'run-1',
    model: 'test-model',
    text,
    message: {} as AgentRunResult['message'],
    messages: [],
    stopReason: 'end_turn',
    requests: [],
    toolCalls: [],
    startedAt: '2026-07-11T00:00:00.000Z',
    completedAt: '2026-07-11T00:00:01.000Z',
  };
}

function runStarted(): AgentEvent {
  return {
    type: 'run.started',
    runId: 'run-1',
    model: 'test-model',
    input: 'hello',
    timestamp: '2026-07-11T00:00:00.000Z',
  };
}

function requestStarted(): AgentEvent {
  return {
    type: 'request.started',
    runId: 'run-1',
    iteration: 1,
    timestamp: '2026-07-11T00:00:00.100Z',
  };
}

function textDelta(delta: string, snapshot: string): AgentEvent {
  return {
    type: 'response.text.delta',
    runId: 'run-1',
    iteration: 1,
    delta,
    snapshot,
    timestamp: '2026-07-11T00:00:00.200Z',
  };
}

function responseCompleted(result: AgentRunResult): AgentEvent {
  return {
    type: 'response.completed',
    runId: 'run-1',
    result,
    timestamp: '2026-07-11T00:00:01.000Z',
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('AsyncQueue', () => {
  it('enforces capacity with explicit oldest/newest/error overflow policies', async () => {
    const oldest = new AsyncQueue<number>({ capacity: 2, overflowStrategy: 'drop-oldest' });
    oldest.push(1);
    oldest.push(2);
    oldest.push(3);
    oldest.close();
    await expect(collect(oldest)).resolves.toEqual([2, 3]);

    const newest = new AsyncQueue<number>({ capacity: 2, overflowStrategy: 'drop-newest' });
    newest.push(1);
    newest.push(2);
    expect(newest.push(3)).toBe(false);
    newest.close();
    await expect(collect(newest)).resolves.toEqual([1, 2]);

    const strict = new AsyncQueue<number>({ capacity: 2 });
    strict.push(1);
    strict.push(2);
    expect(() => strict.push(3)).toThrow(AsyncQueueOverflowError);
    expect(strict.bufferedSize).toBe(2);
    strict.close();
    await expect(collect(strict)).resolves.toEqual([1, 2]);
  });

  it('wakes waiting consumers and applies backpressure to async producers', async () => {
    const queue = new AsyncQueue<number>({ capacity: 1 });
    const iterator = queue[Symbol.asyncIterator]();
    const waitingConsumer = iterator.next();
    expect(queue.pendingConsumerCount).toBe(1);

    queue.push(1);
    await expect(waitingConsumer).resolves.toEqual({ value: 1, done: false });
    expect(queue.pendingConsumerCount).toBe(0);

    queue.push(2);
    const pushed = queue.pushAsync(3);
    expect(queue.pendingProducerCount).toBe(1);

    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    await expect(pushed).resolves.toBeUndefined();
    expect(queue.pendingProducerCount).toBe(0);
    await expect(iterator.next()).resolves.toEqual({ value: 3, done: false });
    queue.close();
  });

  it('removes a pending consumer when iterator.return is called', async () => {
    const queue = new AsyncQueue<number>({ capacity: 1 });
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    expect(queue.pendingConsumerCount).toBe(1);

    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    await expect(waiting).resolves.toEqual({ value: undefined, done: true });
    expect(queue.pendingConsumerCount).toBe(0);

    const replacement = queue[Symbol.asyncIterator]();
    queue.push(4);
    await expect(replacement.next()).resolves.toEqual({ value: 4, done: false });
    queue.close();
  });

  it('rejects and removes producer and consumer waiters on abort/cancel', async () => {
    const producerQueue = new AsyncQueue<number>({ capacity: 1 });
    producerQueue.push(1);
    const producerAbort = new AbortController();
    const waitingProducer = producerQueue.pushAsync(2, { signal: producerAbort.signal });
    expect(producerQueue.pendingProducerCount).toBe(1);
    producerAbort.abort('producer stopped');
    await expect(waitingProducer).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerQueue.pendingProducerCount).toBe(0);

    const consumerQueue = new AsyncQueue<number>({ capacity: 1 });
    const waitingConsumer = consumerQueue[Symbol.asyncIterator]().next();
    expect(consumerQueue.pendingConsumerCount).toBe(1);
    consumerQueue.cancel('queue stopped');
    await expect(waitingConsumer).rejects.toMatchObject({ name: 'AbortError' });
    expect(consumerQueue.pendingConsumerCount).toBe(0);
    expect(consumerQueue.pendingProducerCount).toBe(0);
  });
});

describe('AgentRunStream', () => {
  it('coalesces buffered text deltas without losing text and preserves terminal events', async () => {
    const result = createRunResult('abc');
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      controller.emit(textDelta('a', 'a'));
      controller.emit(textDelta('b', 'ab'));
      controller.emit(textDelta('c', 'abc'));
      controller.emit(responseCompleted(result));
      return result;
    }, { maxBufferedEvents: 3 });

    await expect(stream.result).resolves.toBe(result);
    expect(stream.bufferedEventCount).toBeLessThanOrEqual(3);
    const events = await collect(stream);
    expect(events.map(event => event.type)).toEqual([
      'run.started',
      'response.text.delta',
      'response.completed',
    ]);
    expect(events[1]).toMatchObject({ delta: 'abc', snapshot: 'abc' });
  });

  it('keeps a high-volume unconsumed delta stream within its event limit', async () => {
    const deltaCount = 20_000;
    const result = createRunResult('x'.repeat(deltaCount));
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      for (let index = 0; index < deltaCount; index += 1) {
        controller.emit(textDelta('x', `snapshot-${index}`));
      }
      controller.emit(responseCompleted(result));
      return result;
    }, { maxBufferedEvents: 3 });

    await stream.result;
    expect(stream.bufferedEventCount).toBeLessThanOrEqual(3);
    const events = await collect(stream);
    const delta = events.find(event => event.type === 'response.text.delta');
    expect(delta).toMatchObject({ type: 'response.text.delta' });
    if (delta?.type === 'response.text.delta') {
      expect(delta.delta).toHaveLength(deltaCount);
      expect(delta.snapshot).toBe(`snapshot-${deltaCount - 1}`);
    }
    expect(events.at(-1)?.type).toBe('response.completed');
  });

  it('reserves capacity for completion when normal lifecycle events fill the buffer', async () => {
    const result = createRunResult();
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      controller.emit(requestStarted());
      controller.emit(responseCompleted(result));
      return result;
    }, { maxBufferedEvents: 3, coalesceDeltas: false });

    await stream.result;
    const events = await collect(stream);
    expect(events.map(event => event.type)).toEqual([
      'run.started',
      'request.started',
      'response.completed',
    ]);
  });

  it('delivers a buffered error event before surfacing executor failure', async () => {
    const failure = new Error('provider failed');
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      controller.emit({
        type: 'error',
        runId: 'run-1',
        error: { message: failure.message },
        timestamp: '2026-07-11T00:00:01.000Z',
      });
      throw failure;
    }, { maxBufferedEvents: 2 });
    const resultRejection = stream.result.catch(error => error);

    const seen: AgentEvent[] = [];
    await expect((async () => {
      for await (const event of stream) {
        seen.push(event);
      }
    })()).rejects.toBe(failure);
    expect(seen.map(event => event.type)).toEqual(['run.started', 'error']);
    await expect(resultRejection).resolves.toBe(failure);
  });

  it('cancels the executor and clears waiters when a consumer returns early', async () => {
    const result = createRunResult();
    const executorStopped = vi.fn();
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      await new Promise<void>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      executorStopped();
      return result;
    });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'run.started' },
      done: false,
    });
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    await expect(stream.result).resolves.toBe(result);
    expect(executorStopped).toHaveBeenCalledOnce();
    expect(stream.isCancelled).toBe(true);
    expect(stream.bufferedEventCount).toBe(0);
    expect(stream.pendingConsumerCount).toBe(0);
    expect(stream.pendingProducerCount).toBe(0);
  });

  it('discards buffered events on return even after the executor has closed the queue', async () => {
    const result = createRunResult('ab');
    const stream = new AgentRunStream(async controller => {
      controller.emit(runStarted());
      controller.emit(textDelta('a', 'a'));
      controller.emit(textDelta('b', 'ab'));
      controller.emit(responseCompleted(result));
      return result;
    }, { maxBufferedEvents: 3 });
    await stream.result;

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    expect(stream.bufferedEventCount).toBeGreaterThan(0);
    await iterator.return?.();
    expect(stream.bufferedEventCount).toBe(0);
    expect(stream.pendingConsumerCount).toBe(0);
    expect(stream.pendingProducerCount).toBe(0);
  });

  it('does not retain a waiting consumer after explicit cancellation', async () => {
    const stream = new AgentRunStream(async controller => {
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      });
      return createRunResult();
    });
    const resultRejection = stream.result.catch(error => error);
    const waiting = stream[Symbol.asyncIterator]().next();
    expect(stream.pendingConsumerCount).toBe(1);

    stream.cancel('caller stopped');
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.pendingConsumerCount).toBe(0);
    expect(stream.pendingProducerCount).toBe(0);
    await expect(resultRejection).resolves.toMatchObject({ name: 'AbortError' });
  });
});
