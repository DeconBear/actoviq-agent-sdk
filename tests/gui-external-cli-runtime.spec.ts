import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const externalCliAuthProbe = vi.hoisted(() => vi.fn(async (runtime: string) => ({
  runtime,
  state: 'configured',
  source: 'native-cli',
  message: `${runtime} test authentication is configured.`,
})));

vi.mock('../src/parity/externalCliAuth.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/parity/externalCliAuth.js')>(),
  probeExternalCliAuth: externalCliAuthProbe,
}));

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { writeBridgeConfigs } from '../src/parity/bridgeConfigs.js';
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
import type { AgentExecutionProjectView } from '../src/ui/agentExecutionView.js';

const tempDirs: string[] = [];
const managedRuntimeProviderCases = [
  ['claude', 'anthropic'],
  ['codex', 'openai'],
  ['pi', 'openai'],
  ['codewhale', 'anthropic'],
  ['reasonix', 'openai'],
  ['crush', 'openai'],
] as const;

class FakeRunStream implements ExternalCliRunStreamLike {
  readonly result: Promise<ActoviqBridgeRunResult>;

  constructor(
    private readonly events: ActoviqBridgeJsonEvent[],
    result: ActoviqBridgeRunResult,
  ) {
    this.result = Promise.resolve(result);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    for (const event of this.events) yield event;
  }
}

class DeferredRunStream implements ExternalCliRunStreamLike {
  readonly result: Promise<ActoviqBridgeRunResult>;
  private readonly ready: Promise<void>;
  private release!: () => void;

  constructor(
    private readonly sessionId: string,
    private readonly text: string,
  ) {
    this.ready = new Promise<void>(resolve => {
      this.release = resolve;
    });
    this.result = this.ready.then(() => ({
      text: this.text,
      sessionId: this.sessionId,
      isError: false,
      exitCode: 0,
      stderr: '',
      resultEvent: { type: 'result', session_id: this.sessionId },
      assistantMessages: [],
      events: [],
    }));
  }

  complete(): void {
    this.release();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    await this.ready;
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
    };
    yield {
      type: 'stream_event',
      session_id: this.sessionId,
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: this.text },
      },
    };
  }
}

class AbortableRunStream implements ExternalCliRunStreamLike {
  readonly result: Promise<ActoviqBridgeRunResult>;

  constructor(signal: AbortSignal | undefined) {
    this.result = new Promise((_resolve, reject) => {
      const fail = () => reject(new Error('aborted after HTTP disconnect'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    await this.result;
  }
}

type FakeStreamFactory = (
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
    private readonly streamFactory?: FakeStreamFactory,
  ) {}

  stream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ExternalCliRunStreamLike {
    this.streamCalls.push({ prompt, options });
    if (this.streamFactory) return this.streamFactory(this, prompt, options);
    const text = `external reply: ${prompt}`;
    return new FakeRunStream(
      [
        {
          type: 'system',
          subtype: 'init',
          session_id: this.id,
          model: 'claude-sonnet-test',
        },
        {
          type: 'stream_event',
          session_id: this.id,
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text },
          },
        },
      ],
      {
        text,
        sessionId: this.id,
        isError: false,
        exitCode: 0,
        stderr: '',
        resultEvent: { type: 'result', session_id: this.id },
        assistantMessages: [],
        events: [],
      },
    );
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

  constructor(private readonly streamFactory?: FakeStreamFactory) {}

  async createSession(
    options: ActoviqBridgeSessionCreateOptions = {},
  ): Promise<ExternalCliSessionLike> {
    this.createSessionCalls.push(options);
    const session = new FakeSession(
      `native-claude-${this.sessions.length + 1}`,
      this.streamFactory,
    );
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

async function apiJson<T>(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(requestPath.replace(/^\/+/, ''), server.url), {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() as T };
}

async function send(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  text: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(new URL('api/send', server.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actoviq-token': server.token,
    },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(200);
  return (await response.text())
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.stubEnv('ACTOVIQ_API_KEY', '');
  vi.stubEnv('ACTOVIQ_AUTH_TOKEN', '');
  externalCliAuthProbe.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('GUI External CLI runtime', () => {
  it('accepts configuration and authentication gates for all six managed runtimes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-runtime-gates-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const configPath = path.join(root, 'settings.json');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ env: {} }), 'utf8');
    writeBridgeConfigs({
      configs: managedRuntimeProviderCases.map(([runtime, provider]) => ({
        name: `${runtime}-native`,
        runtime,
        provider,
        execution: 'cli',
        authSource: 'native',
      })),
    }, homeDir);
    const server = await startActoviqGuiServer({
      configPath,
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const state = await apiJson<{
        bridgeState: { configs: Array<Record<string, unknown>> };
      }>(server, '/api/state');
      expect(state.status).toBe(200);
      for (const [runtime, provider] of managedRuntimeProviderCases) {
        expect(state.body.bridgeState.configs).toContainEqual(expect.objectContaining({
          name: `${runtime}-native`,
          runtime,
          provider,
          execution: 'cli',
          authSource: 'native',
        }));
      }

      const hadamardCli = await apiJson<{ error: string }>(server, '/api/bridge/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'invalid-hadamard-cli',
          runtime: 'hadamard',
          provider: 'openai',
          execution: 'cli',
          authSource: 'native',
        }),
      });
      expect(hadamardCli.status).toBe(400);
      expect(hadamardCli.body.error).toMatch(/requires a CLI runtime/iu);

      const auth = await apiJson<{
        runtimes: Array<{ runtime: string; state: string; source: string }>;
      }>(server, '/api/external-cli/auth');
      expect(auth.status).toBe(200);
      expect(auth.body.runtimes.map(item => item.runtime)).toEqual([
        'claude',
        'codewhale',
        'pi',
        'codex',
        'reasonix',
        'crush',
      ]);
      expect(auth.body.runtimes.every(item =>
        item.state === 'configured' && item.source === 'native-cli')).toBe(true);
      expect(externalCliAuthProbe.mock.calls.map(call => call[0])).toEqual([
        'claude',
        'codewhale',
        'pi',
        'codex',
        'reasonix',
        'crush',
      ]);
    } finally {
      await server.close();
    }
  });

  it('streams through Claude Code without a Hadamard credential and reuses its native session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-external-runtime-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const configPath = path.join(root, 'settings.json');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ env: {} }), 'utf8');
    writeBridgeConfigs({
      configs: [{
        name: 'claude-native',
        runtime: 'claude',
        execution: 'cli',
        authSource: 'native',
        provider: 'anthropic',
        model: 'claude-sonnet-test',
      }],
    }, homeDir);

    const factoryOptions: CreateActoviqBridgeSdkOptions[] = [];
    const clients: FakeClient[] = [];
    const externalCliRuntimeManager = new ExternalCliRuntimeManager({
      clientFactory: async options => {
        factoryOptions.push(options);
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    const streamSpy = vi.spyOn(externalCliRuntimeManager, 'stream');
    const startSpy = vi.spyOn(externalCliRuntimeManager, 'start');
    const server = await startActoviqGuiServer({
      configPath,
      externalCliRuntimeManager,
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const activated = await apiJson<{
        needsCredentials: boolean;
        bridgeState: { activeConfig: Record<string, unknown> | null };
      }>(server, '/api/bridge/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-native' }),
      });
      expect(activated.status).toBe(200);
      expect(activated.body.needsCredentials).toBe(true);
      expect(activated.body.bridgeState.activeConfig).toMatchObject({
        name: 'claude-native',
        runtime: 'claude',
        execution: 'cli',
        authSource: 'native',
        model: 'claude-sonnet-test',
      });

      const firstEvents = await send(server, 'first turn');
      const afterFirst = await apiJson<{
        bridgeState: { activeConfig: { nativeSessionId?: string } | null };
      }>(server, '/api/state');
      expect(afterFirst.body.bridgeState.activeConfig?.nativeSessionId).toBe('native-claude-1');
      const secondEvents = await send(server, 'second turn');
      for (const [events, input, expected] of [
        [firstEvents, 'first turn', 'external reply: first turn'],
        [secondEvents, 'second turn', 'external reply: second turn'],
      ] as const) {
        expect(events).toContainEqual(expect.objectContaining({ type: 'user', text: input }));
        expect(events).toContainEqual(expect.objectContaining({
          type: 'notice',
          message: 'external CLI -> claude (native login)',
        }));
        expect(events).toContainEqual(expect.objectContaining({ type: 'delta', text: expected }));
        expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'done' }));
        expect(events.some(event => event.type === 'error')).toBe(false);
      }

      expect(streamSpy).toHaveBeenCalledTimes(2);
      const firstRun = streamSpy.mock.calls[0]![0];
      const secondRun = streamSpy.mock.calls[1]![0];
      expect(firstRun).toMatchObject({
        actoviqSessionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        configId: expect.stringMatching(/^claude-native:[a-f0-9]{24}$/),
        cwd: path.resolve(workDir),
        prompt: 'first turn',
        clientOptions: {
          directCliProvider: 'claude',
          authSource: 'native',
        },
        sessionOptions: {
          title: 'actoviq-gui-claude-claude-native',
        },
        runOptions: {
          includePartialMessages: true,
          model: 'claude-sonnet-test',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(firstRun.nativeSessionId).toBeUndefined();
      expect(firstRun.clientOptions).not.toHaveProperty('apiKey');
      expect(secondRun).toMatchObject({
        actoviqSessionId: firstRun.actoviqSessionId,
        configId: firstRun.configId,
        cwd: firstRun.cwd,
        prompt: 'second turn',
        nativeSessionId: 'native-claude-1',
      });

      expect(factoryOptions).toHaveLength(1);
      expect(factoryOptions[0]).toMatchObject({
        directCli: true,
        directCliProvider: 'claude',
        authSource: 'native',
        workDir: path.resolve(workDir),
      });
      expect(factoryOptions[0]).not.toHaveProperty('apiKey');
      expect(clients).toHaveLength(1);
      const client = clients[0]!;
      expect(client.createSessionCalls).toHaveLength(1);
      expect(client.createSessionCalls[0]).toMatchObject({
        directCli: true,
        title: 'actoviq-gui-claude-claude-native',
        workDir: path.resolve(workDir),
      });
      expect(client.resumeSessionCalls).toHaveLength(0);
      expect(client.sessions).toHaveLength(1);
      const arbitraryResume = await apiJson<{ error: string }>(server, '/api/external-cli/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          configName: 'claude-native',
          prompt: 'unvalidated resume',
          nativeSessionId: '--dangerously-skip-permissions',
        }),
      });
      expect(arbitraryResume.status).toBe(400);
      expect(arbitraryResume.body.error).toMatch(/validated external session history/iu);
      const background = await apiJson<{
        run: { runId: string; background: boolean; status: string };
      }>(server, '/api/external-cli/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          configName: 'claude-native',
          prompt: 'background turn',
        }),
      });
      expect(background.status).toBe(202);
      expect(background.body.run).toMatchObject({
        runId: expect.any(String),
        background: true,
      });
      expect(background.body.run).not.toHaveProperty('configId');
      expect(background.body.run).not.toHaveProperty('actoviqSessionId');
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy.mock.calls[0]![0]).toMatchObject({
        actoviqSessionId: firstRun.actoviqSessionId,
        configId: firstRun.configId,
        cwd: firstRun.cwd,
        prompt: 'background turn',
        background: true,
        nativeSessionId: 'native-claude-1',
      });

      type BackgroundReplay = {
        run: { status: string; result?: { text: string } };
        updates: Array<{ kind: string; event?: { type?: string } }>;
      };
      let backgroundReplay: BackgroundReplay | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const replay = await apiJson<BackgroundReplay>(
          server,
          '/api/external-cli/run?runId=' + encodeURIComponent(background.body.run.runId),
        );
        expect(replay.status).toBe(200);
        backgroundReplay = replay.body;
        if (backgroundReplay?.run.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(backgroundReplay?.run).toMatchObject({
        status: 'completed',
        result: { text: 'external reply: background turn' },
      });
      expect(backgroundReplay?.run).not.toHaveProperty('events');
      expect(backgroundReplay?.run).not.toHaveProperty('logs');
      expect(backgroundReplay?.updates.some(update =>
        update.kind === 'event' && update.event?.type === 'stream_event')).toBe(true);

      const nativeSession = client.sessions[0]!;
      expect(nativeSession.streamCalls.map(call => call.prompt)).toEqual([
        'first turn',
        'second turn',
        'background turn',
      ]);
      for (const call of nativeSession.streamCalls) {
        expect(call.options).toMatchObject({
          directCli: true,
          includePartialMessages: true,
          model: 'claude-sonnet-test',
          permissionMode: 'bypassPermissions',
          workDir: path.resolve(workDir),
        });
        expect(call.options.signal).toBeInstanceOf(AbortSignal);
      }

      const runs = await apiJson<{
        runs: Array<{
          runId: string;
          status: string;
          nativeSessionId?: string;
          result?: { text: string };
        }>;
      }>(server, '/api/external-cli/runs');
      expect(runs.status).toBe(200);
      expect(runs.body.runs).toHaveLength(3);
      expect(runs.body.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          nativeSessionId: 'native-claude-1',
        }),
      ]));
      expect(runs.body.runs.every(run => run.nativeSessionId === 'native-claude-1')).toBe(true);
      expect(runs.body.runs.every(run => !('configId' in run))).toBe(true);
      expect(runs.body.runs.every(run => !('actoviqSessionId' in run))).toBe(true);
      expect(runs.body.runs.every(run => !('events' in run))).toBe(true);
      expect(runs.body.runs.every(run => !('logs' in run))).toBe(true);
      expect(runs.body.runs.every(run => !('result' in run))).toBe(true);
    } finally {
      await server.close();
    }
    expect(clients[0]!.closeCount).toBe(1);
  }, 30_000);

  it('persists a background result only to the chat where it was started', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-external-origin-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const configPath = path.join(root, 'settings.json');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ env: {} }), 'utf8');
    writeBridgeConfigs({
      configs: [
        {
          name: 'claude-native',
          runtime: 'claude',
          execution: 'cli',
          authSource: 'native',
          provider: 'anthropic',
        },
        {
          name: 'claude-secondary',
          runtime: 'claude',
          execution: 'cli',
          authSource: 'native',
          provider: 'anthropic',
        },
      ],
    }, homeDir);

    let deferred: DeferredRunStream | undefined;
    const manager = new ExternalCliRuntimeManager({
      clientFactory: async () => new FakeClient((session, prompt) => {
        deferred = new DeferredRunStream(session.id, `background reply: ${prompt}`);
        return deferred;
      }),
    });
    const server = await startActoviqGuiServer({
      configPath,
      externalCliRuntimeManager: manager,
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      await apiJson(server, '/api/bridge/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-native' }),
      });
      const initial = await apiJson<{ session: { id: string } }>(server, '/api/state');
      const originSessionId = initial.body.session.id;
      const started = await apiJson<{ run: { runId: string } }>(server, '/api/external-cli/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          configName: 'claude-secondary',
          prompt: 'long task',
          background: true,
        }),
      });
      for (let attempt = 0; attempt < 100 && !deferred; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(deferred).toBeDefined();

      const runningMonitor = await apiJson<AgentExecutionProjectView>(
        server,
        '/api/agent-executions?path=' + encodeURIComponent(workDir),
      );
      expect(runningMonitor.body.active).toHaveLength(1);
      expect(runningMonitor.body.active[0]).toMatchObject({
        lifecycle: 'running',
        subagentCount: 0,
        root: {
          sessionId: originSessionId,
          runtime: 'claude',
          displayName: 'claude-secondary',
        },
      });

      const blockedNewSession = await apiJson<{ error: string }>(server, '/api/session/new', {
        method: 'POST',
      });
      expect(blockedNewSession.status).toBe(409);
      expect(blockedNewSession.body.error).toContain('External CLI');
      deferred!.complete();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const replay = await apiJson<{ run: { status: string } }>(
          server,
          '/api/external-cli/run?runId=' + encodeURIComponent(started.body.run.runId),
        );
        if (replay.body.run.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      const completedMonitor = await apiJson<AgentExecutionProjectView>(
        server,
        '/api/agent-executions?path=' + encodeURIComponent(workDir),
      );
      expect(completedMonitor.body.active).toEqual([]);
      expect(completedMonitor.body.waiting).toEqual([]);
      expect(completedMonitor.body.completed).toHaveLength(1);
      expect(completedMonitor.body.completed[0]).toMatchObject({
        lifecycle: 'completed',
        root: { status: 'completed', threadStatus: 'idle' },
      });

      const created = await apiJson<{ session: { id: string } }>(server, '/api/session/new', {
        method: 'POST',
      });
      expect(created.status).toBe(200);
      expect(created.body.session.id).not.toBe(originSessionId);

      const currentMessages = await apiJson<{ messages: unknown[] }>(
        server,
        '/api/session/messages',
      );
      expect(currentMessages.body.messages).toEqual([]);

      let originMessages: Array<Record<string, unknown>> = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await apiJson(server, '/api/session/resume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: originSessionId }),
        });
        const messages = await apiJson<{ messages: Array<Record<string, unknown>> }>(
          server,
          '/api/session/messages',
        );
        originMessages = messages.body.messages;
        if (originMessages.length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(originMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user', text: 'long task' }),
        expect.objectContaining({ type: 'assistant', text: 'background reply: long task' }),
      ]));
      const restored = await apiJson<{
        bridgeState: { activeConfig: { name?: string } | null };
      }>(server, '/api/state');
      expect(restored.body.bridgeState.activeConfig?.name).toBe('claude-native');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('keeps the external CLI running across an HTTP disconnect and aborts it explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-external-disconnect-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const configPath = path.join(root, 'settings.json');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ env: {} }), 'utf8');
    writeBridgeConfigs({
      configs: [{
        name: 'claude-native',
        runtime: 'claude',
        execution: 'cli',
        authSource: 'native',
        provider: 'anthropic',
      }],
    }, homeDir);

    let childSignal: AbortSignal | undefined;
    const manager = new ExternalCliRuntimeManager({
      clientFactory: async () => new FakeClient((_session, _prompt, options) => {
        childSignal = options.signal;
        return new AbortableRunStream(options.signal);
      }),
    });
    const server = await startActoviqGuiServer({
      configPath,
      externalCliRuntimeManager: manager,
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      await apiJson(server, '/api/bridge/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-native' }),
      });
      const disconnect = new AbortController();
      const clientRequestId = 'external-disconnect-recovery';
      const response = await fetch(new URL('api/send', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actoviq-token': server.token,
        },
        body: JSON.stringify({ text: 'stay running', clientRequestId }),
        signal: disconnect.signal,
      });
      expect(response.status).toBe(200);
      const signalDeadline = Date.now() + 5_000;
      while (!childSignal && Date.now() < signalDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(childSignal).toBeDefined();
      disconnect.abort();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(childSignal?.aborted).toBe(false);
      expect(manager.list()[0]?.status).toBe('running');

      const liveRuns = await apiJson<{
        runs: Array<{ runId: string; clientRequestId?: string; status: string }>;
      }>(server, '/api/runs');
      const guiRun = liveRuns.body.runs.find(run => run.clientRequestId === clientRequestId);
      expect(guiRun).toEqual(expect.objectContaining({ status: 'running' }));

      const replay = await apiJson<{ active: boolean; events: Array<{ type: string }> }>(
        server,
        `/api/run/events?runId=${encodeURIComponent(guiRun!.runId)}&after=0`,
      );
      expect(replay.body.active).toBe(true);
      expect(replay.body.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user' }),
      ]));

      const abort = await apiJson<{ aborted: boolean }>(server, '/api/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: guiRun!.runId }),
      });
      expect(abort.body.aborted).toBe(true);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (childSignal?.aborted && manager.list()[0]?.status === 'aborted') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(childSignal?.aborted).toBe(true);
      expect(manager.list()[0]?.status).toBe('aborted');
    } finally {
      await server.close();
    }
  });
});
