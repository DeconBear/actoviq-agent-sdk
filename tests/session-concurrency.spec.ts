import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSdk,
  SessionStore,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import { extractTextFromContent } from '../src/runtime/messageUtils.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeMessage(text: string): Message {
  messageCounter += 1;
  return {
    id: `session_concurrency_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1,
      output_tokens: 1,
    },
  } as Message;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

interface ControlledCreateCall {
  request: ModelRequest;
  response: Deferred<Message>;
}

interface ControlledStreamCall {
  request: ModelRequest;
  release: Deferred<void>;
  message: Message;
}

class ControlledModelApi implements ModelApi {
  readonly createCalls: ControlledCreateCall[] = [];
  readonly streamCalls: ControlledStreamCall[] = [];
  activeRequests = 0;
  maxActiveRequests = 0;

  async createMessage(request: ModelRequest): Promise<Message> {
    const response = deferred<Message>();
    this.createCalls.push({ request, response });
    this.started();
    try {
      return await response.promise;
    } finally {
      this.finished();
    }
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    const release = deferred<void>();
    const message = makeMessage(`stream answer ${this.streamCalls.length + 1}`);
    const call = { request, release, message };
    this.streamCalls.push(call);
    this.started();
    const finish = () => this.finished();

    return {
      async finalMessage(): Promise<Message> {
        return message;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
        try {
          await Promise.race([
            release.promise,
            new Promise<never>((_resolve, reject) => {
              const signal = request.signal;
              if (!signal) return;
              const rejectForAbort = () => reject(signal.reason ?? new Error('aborted'));
              if (signal.aborted) {
                rejectForAbort();
                return;
              }
              signal.addEventListener('abort', rejectForAbort, { once: true });
            }),
          ]);
        } finally {
          finish();
        }
      },
    };
  }

  private started(): void {
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
  }

  private finished(): void {
    this.activeRequests -= 1;
  }
}

async function createSessionDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'actoviq-session-concurrency-'));
  tempDirs.push(directory);
  return directory;
}

function requestTranscript(request: ModelRequest): string[] {
  return request.messages.map(message => extractTextFromContent(message.content));
}

describe('AgentSession turn serialization', () => {
  it('serializes concurrent sends and starts the queued turn from the committed transcript', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const session = await sdk.createSession({ title: 'Same-session sends' });
      const first = session.send('first turn');
      const second = session.send('second turn');

      await waitFor(() => modelApi.createCalls.length === 1, 'the first model request');
      expect(modelApi.createCalls).toHaveLength(1);
      expect(modelApi.maxActiveRequests).toBe(1);

      modelApi.createCalls[0]!.response.resolve(makeMessage('first answer'));
      await first;
      await waitFor(() => modelApi.createCalls.length === 2, 'the queued model request');

      expect(requestTranscript(modelApi.createCalls[1]!.request)).toEqual([
        'first turn',
        'first answer',
        'second turn',
      ]);
      expect(modelApi.maxActiveRequests).toBe(1);

      modelApi.createCalls[1]!.response.resolve(makeMessage('second answer'));
      await second;

      const stored = await new SessionStore(sessionDirectory).load(session.id);
      expect(stored.messages.map(message => extractTextFromContent(message.content))).toEqual([
        'first turn',
        'first answer',
        'second turn',
        'second answer',
      ]);
    } finally {
      await sdk.close();
    }
  });

  it.each([1, 10, 100])(
    'persists every message from %i concurrent sends to one session',
    async (turnCount) => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const session = await sdk.createSession({ title: `${turnCount} same-session sends` });
      const sends = Array.from({ length: turnCount }, (_, index) => (
        session.send(`turn ${index}`)
      ));

      for (let index = 0; index < sends.length; index += 1) {
        await waitFor(
          () => modelApi.createCalls.length === index + 1,
          `serialized model request ${index + 1}`,
          5_000,
        );
        expect(modelApi.maxActiveRequests).toBe(1);
        modelApi.createCalls[index]!.response.resolve(makeMessage(`answer ${index}`));
      }
      await Promise.all(sends);

      const stored = await new SessionStore(sessionDirectory).load(session.id);
      expect(stored.messages).toHaveLength(turnCount * 2);
      expect(stored.messages.map(message => extractTextFromContent(message.content))).toEqual(
        Array.from({ length: turnCount }, (_, index) => [
          `turn ${index}`,
          `answer ${index}`,
        ]).flat(),
      );
    } finally {
      await sdk.close();
    }
    },
    15_000,
  );

  it('allows turns for different sessions to run concurrently', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const firstSession = await sdk.createSession({ title: 'First session' });
      const secondSession = await sdk.createSession({ title: 'Second session' });
      const first = firstSession.send('first session turn');
      const second = secondSession.send('second session turn');

      await waitFor(() => modelApi.createCalls.length === 2, 'both model requests');
      expect(modelApi.maxActiveRequests).toBe(2);

      modelApi.createCalls[0]!.response.resolve(makeMessage('first session answer'));
      modelApi.createCalls[1]!.response.resolve(makeMessage('second session answer'));
      await Promise.all([first, second]);
    } finally {
      await sdk.close();
    }
  });

  it('holds the session lock until a stream fully completes', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const session = await sdk.createSession({ title: 'Stream serialization' });
      const stream = session.stream('streamed turn');
      const queuedSend = session.send('turn after stream');

      await waitFor(() => modelApi.streamCalls.length === 1, 'the streaming model request');
      expect(modelApi.createCalls).toHaveLength(0);

      modelApi.streamCalls[0]!.release.resolve();
      await stream.result;
      await waitFor(() => modelApi.createCalls.length === 1, 'the turn queued after the stream');
      expect(requestTranscript(modelApi.createCalls[0]!.request)).toEqual([
        'streamed turn',
        'stream answer 1',
        'turn after stream',
      ]);

      modelApi.createCalls[0]!.response.resolve(makeMessage('answer after stream'));
      await queuedSend;
    } finally {
      await sdk.close();
    }
  });

  it('releases the session lock after a failed turn', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const session = await sdk.createSession({ title: 'Failure release' });
      const failed = session.send('failing turn');
      const failedOutcome = failed.catch(error => error as Error);
      const queued = session.send('turn after failure');

      await waitFor(() => modelApi.createCalls.length === 1, 'the failing model request');
      modelApi.createCalls[0]!.response.reject(new Error('expected model failure'));
      expect((await failedOutcome).message).toBe('expected model failure');

      await waitFor(() => modelApi.createCalls.length === 2, 'the turn queued after failure');
      modelApi.createCalls[1]!.response.resolve(makeMessage('recovered answer'));
      await queued;
    } finally {
      await sdk.close();
    }
  });

  it('releases the session lock after a stream is cancelled', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new ControlledModelApi();
    const sdk = await createAgentSdk({ model: 'test-model', sessionDirectory, modelApi });

    try {
      const session = await sdk.createSession({ title: 'Cancellation release' });
      const stream = session.stream('cancelled stream');
      const streamOutcome = stream.result.catch(error => error as Error);
      const queued = session.send('turn after cancellation');

      await waitFor(() => modelApi.streamCalls.length === 1, 'the cancellable model stream');
      stream.cancel('test cancellation');
      await streamOutcome;

      await waitFor(() => modelApi.createCalls.length === 1, 'the turn queued after cancellation');
      modelApi.createCalls[0]!.response.resolve(makeMessage('answer after cancellation'));
      await queued;
    } finally {
      await sdk.close();
    }
  });
});
