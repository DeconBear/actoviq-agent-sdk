import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExternalCliRuntimeManager,
  type ExternalCliClientLike,
  type ExternalCliRunStreamLike,
  type ExternalCliSessionLike,
} from '../src/parity/externalCliRuntimeManager.js';
import type {
  ActoviqBridgeJsonEvent,
  ActoviqBridgeRunOptions,
  ActoviqBridgeRunResult,
  ActoviqBridgeSessionCreateOptions,
  CreateActoviqBridgeSdkOptions,
} from '../src/types.js';

function runResult(
  sessionId: string,
  overrides: Partial<ActoviqBridgeRunResult> = {},
): ActoviqBridgeRunResult {
  return {
    text: 'ok',
    sessionId,
    isError: false,
    exitCode: 0,
    stderr: '',
    resultEvent: { type: 'result', session_id: sessionId },
    assistantMessages: [],
    events: [],
    ...overrides,
  };
}

class StaticRunStream implements ExternalCliRunStreamLike {
  readonly result: Promise<ActoviqBridgeRunResult>;

  constructor(
    private readonly eventList: ActoviqBridgeJsonEvent[],
    result: ActoviqBridgeRunResult,
  ) {
    this.result = Promise.resolve(result);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    for (const event of this.eventList) yield event;
  }
}

class ControlledRunStream implements ExternalCliRunStreamLike {
  readonly result: Promise<ActoviqBridgeRunResult>;
  private readonly queue: ActoviqBridgeJsonEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly resolveResult: (value: ActoviqBridgeRunResult) => void;
  private readonly rejectResult: (reason?: unknown) => void;
  private done = false;
  private failure: unknown;

  constructor() {
    let resolveResult!: (value: ActoviqBridgeRunResult) => void;
    let rejectResult!: (reason?: unknown) => void;
    this.result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.resolveResult = resolveResult;
    this.rejectResult = rejectResult;
  }

  emit(event: ActoviqBridgeJsonEvent): void {
    this.queue.push(event);
    this.wake();
  }

  finish(result: ActoviqBridgeRunResult): void {
    this.done = true;
    this.resolveResult(result);
    this.wake();
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.failure = error;
    this.done = true;
    this.rejectResult(error);
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.done) return;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

type StreamFactory = (
  session: FakeSession,
  prompt: string,
  options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>,
) => ExternalCliRunStreamLike;

class FakeSession implements ExternalCliSessionLike {
  readonly streamCalls: Array<{
    prompt: string;
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>;
  }> = [];

  constructor(
    readonly id: string,
    private readonly streamFactory: StreamFactory,
  ) {}

  stream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ExternalCliRunStreamLike {
    this.streamCalls.push({ prompt, options });
    return this.streamFactory(this, prompt, options);
  }
}

class FakeClient implements ExternalCliClientLike {
  readonly createSessionCalls: ActoviqBridgeSessionCreateOptions[] = [];
  readonly resumeSessionCalls: Array<{
    sessionId: string;
    options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'>;
  }> = [];
  readonly sessions: FakeSession[] = [];
  closeCount = 0;

  constructor(private readonly streamFactory: StreamFactory) {}

  async createSession(
    options: ActoviqBridgeSessionCreateOptions = {},
  ): Promise<ExternalCliSessionLike> {
    this.createSessionCalls.push(options);
    const session = new FakeSession(`native-${this.sessions.length + 1}`, this.streamFactory);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    sessionId: string,
    options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'> = {},
  ): Promise<ExternalCliSessionLike> {
    this.resumeSessionCalls.push({ sessionId, options });
    const session = new FakeSession(sessionId, this.streamFactory);
    this.sessions.push(session);
    return session;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

interface FakeFactory {
  options: CreateActoviqBridgeSdkOptions[];
  clients: FakeClient[];
  create: (options: CreateActoviqBridgeSdkOptions) => Promise<ExternalCliClientLike>;
}

function fakeFactory(
  streamFactory: StreamFactory = session =>
    new StaticRunStream([{ type: 'assistant', text: 'ok' }], runResult(session.id)),
): FakeFactory {
  const options: CreateActoviqBridgeSdkOptions[] = [];
  const clients: FakeClient[] = [];
  return {
    options,
    clients,
    create: async sdkOptions => {
      options.push(sdkOptions);
      const client = new FakeClient(streamFactory);
      clients.push(client);
      return client;
    },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Condition did not become true.');
}

describe('ExternalCliRuntimeManager', () => {
  const managers: ExternalCliRuntimeManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.close()));
  });

  function createManager(
    factory: FakeFactory,
    options: Omit<ConstructorParameters<typeof ExternalCliRuntimeManager>[0], 'clientFactory'> = {},
  ): ExternalCliRuntimeManager {
    const manager = new ExternalCliRuntimeManager({
      ...options,
      clientFactory: factory.create,
    });
    managers.push(manager);
    return manager;
  }

  it('validates the retained run limit', () => {
    const factory = fakeFactory();

    expect(() => createManager(factory, { maxRetainedRuns: 0 })).toThrow(
      'maxRetainedRuns must be a positive integer.',
    );
    expect(() => createManager(factory, { maxRetainedRuns: 1.5 })).toThrow(
      'maxRetainedRuns must be a positive integer.',
    );
  });

  it('retains only the newest terminal runs without discarding the cached runtime', async () => {
    const factory = fakeFactory();
    let nextRunId = 0;
    const manager = createManager(factory, {
      maxRetainedRuns: 2,
      runIdFactory: () => `run-${++nextRunId}`,
    });
    const baseOptions = {
      actoviqSessionId: 'retained-runs',
      configId: 'codex-native',
      cwd: process.cwd(),
    };

    const first = await manager.start({ ...baseOptions, prompt: 'first' });
    const second = await manager.start({ ...baseOptions, prompt: 'second' });
    const third = await manager.start({ ...baseOptions, prompt: 'third' });

    expect(manager.list().map(run => run.runId)).toEqual([second.runId, third.runId]);
    expect(manager.get(first.runId)).toBeUndefined();
    expect(manager.replay(first.runId)).toBeUndefined();
    expect(await manager.wait(first.runId)).toBeUndefined();
    expect(manager.replay(third.runId)?.run.status).toBe('completed');
    expect(factory.options).toHaveLength(1);
    expect(factory.clients[0]?.sessions[0]?.streamCalls.map(call => call.prompt)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('never evicts queued or running runs and still completes an evicted live stream', async () => {
    let controlled: ControlledRunStream | undefined;
    const factory = fakeFactory((session, prompt, options) => {
      if (prompt === 'instant stream') {
        return new StaticRunStream(
          [{ type: 'assistant', text: 'streamed' }],
          runResult(session.id),
        );
      }
      controlled ??= new ControlledRunStream();
      options.signal?.addEventListener('abort', () => {
        controlled?.fail(new Error('aborted by test'));
      });
      return controlled;
    });
    const manager = createManager(factory, { maxRetainedRuns: 1 });
    const queueOptions = {
      actoviqSessionId: 'protected-active',
      configId: 'claude-native',
      cwd: process.cwd(),
      background: true,
    };

    const running = await manager.start({ ...queueOptions, prompt: 'keep running' });
    await eventually(() => manager.get(running.runId)?.status === 'running');
    const queued = await manager.start({ ...queueOptions, prompt: 'stay queued' });
    expect(manager.list().map(run => run.runId)).toEqual([running.runId, queued.runId]);

    const updates = [];
    for await (const update of manager.stream({
      actoviqSessionId: 'evicted-stream',
      configId: 'codex-native',
      cwd: process.cwd(),
      prompt: 'instant stream',
    })) {
      updates.push(update);
    }
    const streamRunId = updates.find(update => update.kind === 'snapshot')?.run.runId;

    expect(updates.some(update => update.kind === 'event')).toBe(true);
    expect(
      updates.some(update => update.kind === 'status' && update.run.status === 'completed'),
    ).toBe(true);
    expect(streamRunId).toBeDefined();
    expect(manager.get(streamRunId ?? '')).toBeUndefined();
    expect(manager.replay(streamRunId ?? '')).toBeUndefined();
    expect(manager.get(running.runId)?.status).toBe('running');
    expect(manager.get(queued.runId)?.status).toBe('queued');
  });

  it('reuses a client and native session for the same Actoviq session, config, and cwd', async () => {
    const factory = fakeFactory();
    const manager = createManager(factory);
    const cwd = process.cwd();

    const first = await manager.start({
      actoviqSessionId: 'actoviq-1',
      configId: 'codex-native',
      cwd,
      prompt: 'first',
    });
    const second = await manager.start({
      actoviqSessionId: 'actoviq-1',
      configId: 'codex-native',
      cwd: path.join(cwd, '.'),
      prompt: 'second',
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(factory.options).toHaveLength(1);
    expect(factory.options[0]).toMatchObject({ directCli: true, workDir: path.resolve(cwd) });
    expect(factory.clients[0]?.createSessionCalls).toHaveLength(1);
    expect(factory.clients[0]?.sessions[0]?.streamCalls.map(call => call.prompt)).toEqual([
      'first',
      'second',
    ]);
  });

  it('resumes an explicitly selected native CLI session id', async () => {
    const factory = fakeFactory();
    const manager = createManager(factory);

    const run = await manager.start({
      actoviqSessionId: 'actoviq-2',
      configId: 'claude-native',
      cwd: process.cwd(),
      prompt: 'resume me',
      nativeSessionId: 'claude-session-42',
    });

    expect(run.nativeSessionId).toBe('claude-session-42');
    expect(factory.clients[0]?.createSessionCalls).toHaveLength(0);
    expect(factory.clients[0]?.resumeSessionCalls[0]?.sessionId).toBe('claude-session-42');
  });

  it('runs in the background and replays bounded event and log buffers', async () => {
    let controlled: ControlledRunStream | undefined;
    const factory = fakeFactory(session => {
      controlled = new ControlledRunStream();
      return controlled;
    });
    const manager = createManager(factory, { eventCapacity: 2, logCapacity: 3 });

    const queued = await manager.start({
      actoviqSessionId: 'actoviq-3',
      configId: 'codex-background',
      cwd: process.cwd(),
      prompt: 'background work',
      background: true,
    });
    expect(queued.status).toBe('queued');
    await eventually(() => manager.get(queued.runId)?.status === 'running' && controlled !== undefined);

    controlled?.emit({ type: 'assistant', index: 1 });
    controlled?.emit({ type: 'assistant', index: 2 });
    controlled?.emit({ type: 'assistant', index: 3 });
    controlled?.finish(runResult('native-1', { text: 'background result' }));

    const completed = await manager.wait(queued.runId);
    const replay = manager.replay(queued.runId);
    expect(completed?.status).toBe('completed');
    expect(completed?.result?.text).toBe('background result');
    expect(replay?.run.events.map(entry => entry.event.index)).toEqual([2, 3]);
    expect(replay?.run.logs.length).toBeLessThanOrEqual(3);
    expect(replay?.updates.map(update => update.sequence)).toEqual(
      [...(replay?.updates ?? [])].map(update => update.sequence).sort((a, b) => a - b),
    );
  });

  it('bounds oversized events and cumulative run buffers by bytes', async () => {
    const largeText = 'x'.repeat(260);
    const factory = fakeFactory(session =>
      new StaticRunStream(
        [
          { type: 'assistant', index: 1, text: largeText },
          { type: 'assistant', index: 2, text: largeText },
          { type: 'assistant', index: 3, text: largeText },
          { type: 'tool_result', output: 'z'.repeat(8_000) },
        ],
        runResult(session.id),
      ),
    );
    const manager = createManager(factory, {
      eventCapacity: 20,
      logCapacity: 20,
      maxEventBytes: 512,
      maxEventBufferBytes: 800,
      maxLogBytes: 64,
      maxLogBufferBytes: 256,
      now: () => '2026-07-14T00:00:00.000Z',
    });

    const run = await manager.start({
      actoviqSessionId: 'actoviq-byte-bounds',
      configId: 'codex-byte-bounds',
      cwd: process.cwd(),
      prompt: 'large tool output',
    });

    expect(run.events.map(entry => entry.event.index)).not.toContain(1);
    expect(run.events.at(-1)?.event).toMatchObject({
      type: 'truncated',
      truncated: true,
      original_bytes: expect.any(Number),
    });
    expect(Buffer.byteLength(JSON.stringify(run.events), 'utf8')).toBeLessThanOrEqual(800);
    expect(Buffer.byteLength(JSON.stringify(run.logs), 'utf8')).toBeLessThanOrEqual(256);
    expect(run.logs.some(entry => entry.message === 'Run queued.')).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(run.events.at(-1)?.event), 'utf8'))
      .toBeLessThanOrEqual(512);
  });

  it('streams live updates through the manager API', async () => {
    const factory = fakeFactory(session =>
      new StaticRunStream(
        [{ type: 'assistant', text: 'streamed' }],
        runResult(session.id, { text: 'done' }),
      ),
    );
    const manager = createManager(factory);
    const updates = [];

    for await (const update of manager.stream({
      actoviqSessionId: 'actoviq-stream',
      configId: 'claude-stream',
      cwd: process.cwd(),
      prompt: 'stream this',
    })) {
      updates.push(update);
    }

    expect(updates[0]?.kind).toBe('snapshot');
    expect(updates.some(update => update.kind === 'event')).toBe(true);
    expect(
      updates.some(update => update.kind === 'status' && update.run.status === 'completed'),
    ).toBe(true);
  });

  it('aborts an active run through its AbortSignal', async () => {
    let signal: AbortSignal | undefined;
    const factory = fakeFactory((_session, _prompt, options) => {
      const controlled = new ControlledRunStream();
      signal = options.signal;
      options.signal?.addEventListener('abort', () => {
        controlled.fail(new Error('aborted by test'));
      });
      return controlled;
    });
    const manager = createManager(factory);
    const run = await manager.start({
      actoviqSessionId: 'actoviq-4',
      configId: 'claude-abort',
      cwd: process.cwd(),
      prompt: 'keep running',
      background: true,
    });
    await eventually(() => manager.get(run.runId)?.status === 'running' && signal !== undefined);

    expect(manager.abort(run.runId)).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect((await manager.wait(run.runId))?.status).toBe('aborted');
    expect(manager.abort(run.runId)).toBe(false);
  });

  it('closes every cached client, aborts active work, and rejects new starts', async () => {
    let secondStream: ControlledRunStream | undefined;
    const factory = fakeFactory((session, _prompt, options) => {
      if (session.id === 'native-1' && factory.clients.length === 1) {
        return new StaticRunStream([], runResult(session.id));
      }
      secondStream = new ControlledRunStream();
      options.signal?.addEventListener('abort', () => {
        secondStream?.fail(new Error('closed'));
      });
      return secondStream;
    });
    const manager = createManager(factory);
    await manager.start({
      actoviqSessionId: 'close-a',
      configId: 'config-a',
      cwd: process.cwd(),
      prompt: 'finish first',
    });
    const active = await manager.start({
      actoviqSessionId: 'close-b',
      configId: 'config-b',
      cwd: process.cwd(),
      prompt: 'stay active',
      background: true,
    });
    await eventually(() => secondStream !== undefined && manager.get(active.runId)?.status === 'running');

    await manager.close();

    expect(manager.get(active.runId)?.status).toBe('aborted');
    expect(factory.clients).toHaveLength(2);
    expect(factory.clients.every(client => client.closeCount === 1)).toBe(true);
    await expect(
      manager.start({
        actoviqSessionId: 'closed',
        configId: 'closed',
        cwd: process.cwd(),
        prompt: 'no',
      }),
    ).rejects.toThrow('closed');
  });

  it('forwards auth overrides without retaining env values or secrets in status', async () => {
    const envSecret = 'env-secret-value';
    const apiSecret = 'api-secret-value';
    const factory = fakeFactory(session =>
      new StaticRunStream(
        [
          {
            type: 'assistant',
            env: { ANTHROPIC_API_KEY: envSecret },
            apiKey: apiSecret,
            text: `Bearer ${envSecret}`,
          },
        ],
        runResult(session.id, {
          text: `used ${envSecret}`,
          stderr: `api_key=${apiSecret}`,
        }),
      ),
    );
    const manager = createManager(factory);

    const run = await manager.start({
      actoviqSessionId: 'actoviq-secret',
      configId: 'claude-api-key',
      cwd: process.cwd(),
      prompt: 'secret prompt',
      env: { ANTHROPIC_API_KEY: envSecret },
      clientOptions: { authSource: 'apiKey', apiKey: apiSecret },
    });
    const serialized = JSON.stringify({
      get: manager.get(run.runId),
      list: manager.list(),
      replay: manager.replay(run.runId),
    });

    expect(factory.options[0]?.env?.ANTHROPIC_API_KEY).toBe(envSecret);
    expect(factory.options[0]?.apiKey).toBe(apiSecret);
    expect(run.events[0]?.event).not.toHaveProperty('env');
    expect(serialized).not.toContain(envSecret);
    expect(serialized).not.toContain(apiSecret);
    expect(serialized).not.toContain('"env"');
  });

  it('reports bridge error results as failed runs', async () => {
    const factory = fakeFactory(session =>
      new StaticRunStream([], runResult(session.id, { isError: true, text: 'provider failed' })),
    );
    const manager = createManager(factory);

    const run = await manager.start({
      actoviqSessionId: 'failed',
      configId: 'failed',
      cwd: process.cwd(),
      prompt: 'fail',
    });

    expect(run.status).toBe('failed');
    expect(run.error?.name).toBe('ExternalCliRunError');
  });

  it('does not publish a provisional native id when a new session fails before init', async () => {
    let callCount = 0;
    const factory = fakeFactory(session => {
      callCount += 1;
      if (callCount === 1) {
        const failed = new ControlledRunStream();
        queueMicrotask(() => failed.fail(new Error('failed before init')));
        return failed;
      }
      return new StaticRunStream(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'native-confirmed',
          },
        ],
        runResult('native-confirmed'),
      );
    });
    const manager = createManager(factory);
    const options = {
      actoviqSessionId: 'no-provisional-id',
      configId: 'claude-native',
      cwd: process.cwd(),
    };

    const failed = await manager.start({ ...options, prompt: 'fail first' });
    const completed = await manager.start({ ...options, prompt: 'try again' });

    expect(failed.status).toBe('failed');
    expect(failed.nativeSessionId).toBeUndefined();
    expect(completed.status).toBe('completed');
    expect(completed.nativeSessionId).toBe('native-confirmed');
  });
});
