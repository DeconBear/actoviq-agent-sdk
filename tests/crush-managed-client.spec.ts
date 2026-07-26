import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  assertCrushLocalTransport,
  decideCrushPermission,
  runCrushManaged,
  type CrushHttpRequest,
  type CrushHttpRequestOptions,
  type CrushHttpResponse,
  type CrushSpawnFn,
} from '../src/parity/crushManagedClient.js';
import type { ActoviqBridgeJsonEvent } from '../src/types.js';

class FakeChild extends EventEmitter {
  pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    this.exitCode = 0;
    this.emit('close', 0, null);
    return true;
  }
}

function localTransport() {
  return {
    serverHost: 'npipe:////./pipe/actoviq-crush-test',
    socketPath: '\\\\.\\pipe\\actoviq-crush-test',
  };
}

function streamBody(chunks: Array<string | Uint8Array>): AsyncIterable<string | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response(
  statusCode: number,
  body: string | AsyncIterable<string | Uint8Array> = '',
  headers: CrushHttpResponse['headers'] = {},
): CrushHttpResponse {
  return {
    statusCode,
    headers,
    body: typeof body === 'string' ? streamBody(body ? [body] : []) : body,
  };
}

function jsonResponse(value: unknown, statusCode = 200): CrushHttpResponse {
  return response(statusCode, JSON.stringify(value), { 'content-type': 'application/json' });
}

function sse(kind: string, data: Record<string, unknown>, envelope = {}): string {
  return `data: ${JSON.stringify({
    type: kind,
    payload: { type: 'updated', payload: data },
    ...envelope,
  })}\n\n`;
}

function fakeSpawn(child: FakeChild, calls: Array<{
  executable: string;
  args: readonly string[];
  options: SpawnOptions;
}>): CrushSpawnFn {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    return child as unknown as ChildProcess;
  };
}

describe('Crush managed client', () => {
  it('parses fragmented SSE, filters foreign events, and normalizes tools and completion', async () => {
    const child = new FakeChild();
    const spawnCalls: Array<{
      executable: string;
      args: readonly string[];
      options: SpawnOptions;
    }> = [];
    const httpCalls: CrushHttpRequestOptions[] = [];
    const events: ActoviqBridgeJsonEvent[] = [];
    let runId = '';

    const eventBody: AsyncIterable<string | Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        const frames = [
          sse('message', {
            id: 'foreign-workspace',
            role: 'assistant',
            session_id: 'session-1',
            parts: [{ type: 'text', data: { text: 'wrong workspace' } }],
          }, { workspace_id: 'workspace-other' }),
          sse('message', {
            id: 'foreign-client',
            role: 'assistant',
            session_id: 'session-1',
            parts: [{ type: 'text', data: { text: 'wrong client' } }],
          }, { client_id: 'client-other' }),
          sse('message', {
            id: 'foreign-session',
            role: 'assistant',
            session_id: 'session-other',
            parts: [{ type: 'text', data: { text: 'wrong session' } }],
          }),
          sse('message', {
            id: 'foreign-run',
            role: 'assistant',
            session_id: 'session-1',
            run_id: 'run-other',
            parts: [{ type: 'text', data: { text: 'wrong run' } }],
          }),
          sse('message', {
            id: 'assistant-1',
            role: 'assistant',
            session_id: 'session-1',
            parts: [
              { type: 'reasoning', data: { thinking: 'Think' } },
              { type: 'text', data: { text: 'Hel' } },
              {
                type: 'tool_call',
                data: { id: 'tool-1', name: 'view', input: '{"path":"README.md"}', finished: false },
              },
            ],
          }),
          sse('message', {
            id: 'assistant-1',
            role: 'assistant',
            session_id: 'session-1',
            parts: [
              { type: 'reasoning', data: { thinking: 'Thinking' } },
              { type: 'text', data: { text: 'Hello' } },
              {
                type: 'tool_call',
                data: { id: 'tool-1', name: 'view', input: '{"path":"README.md"}', finished: true },
              },
            ],
          }),
          sse('message', {
            id: 'tool-message-1',
            role: 'tool',
            session_id: 'session-1',
            parts: [{
              type: 'tool_result',
              data: { tool_call_id: 'tool-1', name: 'view', content: 'file contents', is_error: false },
            }],
          }),
          sse('agent_event', {
            type: 'error',
            session_id: 'session-1',
            run_id: runId,
            error: 'provider leaked top-secret-value',
          }),
          sse('run_complete', {
            session_id: 'session-1',
            run_id: 'run-other',
            text: 'wrong completion',
          }),
          sse('run_complete', {
            session_id: 'session-1',
            run_id: runId,
            message_id: 'assistant-1',
            text: 'Hello',
          }),
        ].join('');
        yield frames.slice(0, 17);
        yield Buffer.from(frames.slice(17, 101));
        yield frames.slice(101);
      },
    };

    const httpRequest: CrushHttpRequest = async options => {
      httpCalls.push(options);
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'POST' && options.path.endsWith('/sessions')) {
        return jsonResponse({ id: 'session-1' });
      }
      if (options.path.endsWith('/permissions/skip')) return response(200);
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, eventBody, { 'content-type': 'text/event-stream' });
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        runId = (JSON.parse(options.body ?? '{}') as { run_id?: string }).run_id ?? '';
        return response(202);
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    const spawnFn = fakeSpawn(child, spawnCalls);
    const result = await runCrushManaged({
      executable: 'crush-test',
      cwd: process.cwd(),
      prompt: '--prompt-stays-in-json',
      permissionMode: 'default',
      env: { CRUSH_API_KEY: 'top-secret-value' },
      inheritEnvironment: false,
      spawnFn: (executable, args, spawnOptions) => {
        const spawned = spawnFn(executable, args, spawnOptions);
        queueMicrotask(() => child.stderr.write('server top-secret-value'));
        return spawned;
      },
      httpRequest,
      transportFactory: async () => localTransport(),
    }, event => {
      events.push(event);
    });

    expect(result).toMatchObject({ sessionId: 'session-1', exitCode: 0 });
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain('top-secret-value');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual([
      'server',
      '--host',
      'npipe:////./pipe/actoviq-crush-test',
    ]);
    expect(spawnCalls[0]?.args).not.toContain('--prompt-stays-in-json');
    expect(spawnCalls[0]?.options.shell).toBe(false);
    expect(spawnCalls[0]?.options.detached).toBe(process.platform !== 'win32');
    expect(spawnCalls[0]?.options.env).toEqual({ CRUSH_API_KEY: 'top-secret-value' });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('wrong workspace');
    expect(serialized).not.toContain('wrong client');
    expect(serialized).not.toContain('wrong session');
    expect(serialized).not.toContain('wrong run');
    expect(serialized).not.toContain('wrong completion');
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).toContain('[REDACTED]');

    const streamEvents = events.filter(event => event.type === 'stream_event');
    expect(streamEvents.map(event => event.event)).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Think' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hel' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'ing' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'lo' },
      },
    ]);
    expect(events.filter(event => event.type === 'assistant')).toEqual([{
      type: 'assistant',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'view',
          input: { path: 'README.md' },
        }],
      },
    }]);
    expect(events.filter(event => event.type === 'user')).toEqual([{
      type: 'user',
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'file contents',
          is_error: false,
        }],
      },
    }]);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'Hello',
    });
    expect(httpCalls.some(call => call.path.includes('/events?client_id='))).toBe(true);
  });

  it('maps permission modes and resolves edit requests through the grant endpoint', async () => {
    expect(decideCrushPermission('bypassPermissions', { tool_name: 'bash' })).toBe('allow');
    expect(decideCrushPermission('acceptEdits', { tool_name: 'edit' })).toBe('allow_session');
    expect(decideCrushPermission('acceptEdits', { tool_name: 'bash' })).toBe('deny');
    expect(decideCrushPermission('default', { tool_name: 'edit' })).toBe('deny');
    expect(decideCrushPermission('dontAsk', { tool_name: 'edit' })).toBe('deny');
    expect(decideCrushPermission('plan', { tool_name: 'edit' })).toBe('deny');

    const child = new FakeChild();
    const grants: Array<Record<string, unknown>> = [];
    let runId = '';
    const eventBody: AsyncIterable<string | Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield sse('permission_request', {
          id: 'permission-1',
          session_id: 'session-1',
          tool_call_id: 'tool-1',
          tool_name: 'edit',
          action: 'write',
          path: 'README.md',
          params: { path: 'README.md' },
        });
        yield sse('run_complete', {
          session_id: 'session-1',
          run_id: runId,
          text: 'done',
        });
      },
    };
    const httpRequest: CrushHttpRequest = async options => {
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'POST' && options.path.endsWith('/sessions')) {
        return jsonResponse({ id: 'session-1' });
      }
      if (options.path.endsWith('/permissions/skip')) {
        expect(JSON.parse(options.body ?? '{}')).toEqual({ skip: false });
        return response(200);
      }
      if (options.path.endsWith('/permissions/grant')) {
        grants.push(JSON.parse(options.body ?? '{}') as Record<string, unknown>);
        return jsonResponse({ resolved: true });
      }
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, eventBody);
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        runId = (JSON.parse(options.body ?? '{}') as { run_id?: string }).run_id ?? '';
        return response(200);
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    await runCrushManaged({
      cwd: process.cwd(),
      prompt: 'edit the file',
      permissionMode: 'acceptEdits',
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      action: 'allow_session',
      permission: {
        id: 'permission-1',
        session_id: 'session-1',
        tool_name: 'edit',
      },
    });
  });

  it('applies model and child-only provider settings through the official workspace endpoints', async () => {
    const child = new FakeChild();
    const calls: CrushHttpRequestOptions[] = [];
    let runId = '';
    const httpRequest: CrushHttpRequest = async options => {
      calls.push(options);
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (
        options.method === 'POST'
        && (
          options.path.endsWith('/config/set')
          || options.path.endsWith('/config/provider-key')
          || options.path.endsWith('/config/model')
        )
      ) {
        return response(200);
      }
      if (options.method === 'POST' && options.path.endsWith('/sessions')) {
        return jsonResponse({ id: 'session-1' });
      }
      if (options.path.endsWith('/permissions/skip')) return response(200);
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, {
          async *[Symbol.asyncIterator]() {
            yield sse('run_complete', {
              session_id: 'session-1',
              run_id: runId,
              text: 'configured',
            });
          },
        });
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        runId = (JSON.parse(options.body ?? '{}') as { run_id?: string }).run_id ?? '';
        return response(202);
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    const result = await runCrushManaged({
      cwd: process.cwd(),
      prompt: 'use the configured model',
      credentialProvider: 'openai',
      model: 'gpt-5',
      apiKey: 'crush-secret-key',
      baseURL: 'https://provider.example/v1/',
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined);

    expect(result.sessionId).toBe('session-1');
    const configurationCalls = calls.filter(call => call.path.includes('/config/'));
    expect(configurationCalls.map(call => call.path)).toEqual([
      '/v1/workspaces/workspace-1/config/set',
      '/v1/workspaces/workspace-1/config/provider-key',
      '/v1/workspaces/workspace-1/config/model',
    ]);
    expect(configurationCalls.map(call => JSON.parse(call.body ?? '{}'))).toEqual([
      {
        scope: 0,
        key: 'providers.openai.base_url',
        value: 'https://provider.example/v1',
      },
      {
        scope: 0,
        provider_id: 'openai',
        kind: 'string',
        api_key: 'crush-secret-key',
      },
      {
        scope: 0,
        model_type: 'large',
        model: { provider: 'openai', model: 'gpt-5' },
      },
    ]);
    const modelIndex = calls.findIndex(call => call.path.endsWith('/config/model'));
    const initIndex = calls.findIndex(call => call.path.endsWith('/agent/init'));
    expect(modelIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeGreaterThan(modelIndex);
  });

  it('uses workspace scope for a native-login model override', async () => {
    const child = new FakeChild();
    const calls: CrushHttpRequestOptions[] = [];
    let runId = '';
    const httpRequest: CrushHttpRequest = async options => {
      calls.push(options);
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'POST' && options.path.endsWith('/config/model')) {
        return response(200);
      }
      if (options.method === 'POST' && options.path.endsWith('/sessions')) {
        return jsonResponse({ id: 'session-1' });
      }
      if (options.path.endsWith('/permissions/skip')) return response(200);
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, {
          async *[Symbol.asyncIterator]() {
            yield sse('run_complete', {
              session_id: 'session-1',
              run_id: runId,
              text: 'configured',
            });
          },
        });
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        runId = (JSON.parse(options.body ?? '{}') as { run_id?: string }).run_id ?? '';
        return response(202);
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    await runCrushManaged({
      cwd: process.cwd(),
      prompt: 'use the native configured provider',
      credentialProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined);

    const modelCall = calls.find(call => call.path.endsWith('/config/model'));
    expect(JSON.parse(modelCall?.body ?? '{}')).toEqual({
      scope: 1,
      model_type: 'large',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    });
  });

  it('refuses to guess a provider for a plain model', async () => {
    const child = new FakeChild();
    const httpRequest: CrushHttpRequest = async options => {
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    await expect(runCrushManaged({
      cwd: process.cwd(),
      prompt: 'do not guess',
      model: 'plain-model-id',
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined)).rejects.toThrow(/explicit native provider id/u);
  });

  it('cancels the exact session before shutting down the server on abort', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const callOrder: string[] = [];
    let submitted!: () => void;
    const submittedPromise = new Promise<void>(resolve => {
      submitted = resolve;
    });

    const httpRequest: CrushHttpRequest = async options => {
      callOrder.push(`${options.method} ${options.path}`);
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'POST' && options.path.endsWith('/sessions')) {
        return jsonResponse({ id: 'session-1' });
      }
      if (options.path.endsWith('/permissions/skip')) return response(200);
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>(resolve => {
              options.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        });
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        submitted();
        return response(202);
      }
      if (options.path.endsWith('/agent/sessions/session-1/cancel')) return response(200);
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    const run = runCrushManaged({
      cwd: process.cwd(),
      prompt: 'long task',
      signal: controller.signal,
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined);
    await submittedPromise;
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const cancelIndex = callOrder.findIndex(call => call.includes('/agent/sessions/session-1/cancel'));
    const shutdownIndex = callOrder.findIndex(call => call === 'POST /v1/control');
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(cancelIndex);
  });

  it('resumes an exact native session and never substitutes --continue', async () => {
    const child = new FakeChild();
    const calls: CrushHttpRequestOptions[] = [];
    let runId = '';
    const httpRequest: CrushHttpRequest = async options => {
      calls.push(options);
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'GET' && options.path.endsWith('/sessions/session-native')) {
        return jsonResponse({ id: 'session-native' });
      }
      if (options.path.endsWith('/permissions/skip')) return response(200);
      if (options.path.endsWith('/agent/init')) return response(200);
      if (options.method === 'GET' && options.path.endsWith('/agent')) {
        return jsonResponse({ is_ready: true });
      }
      if (options.method === 'GET' && options.path.includes('/events?')) {
        return response(200, {
          async *[Symbol.asyncIterator]() {
            yield sse('run_complete', {
              session_id: 'session-native',
              run_id: runId,
              text: 'resumed',
            });
          },
        });
      }
      if (options.path.includes('/current-session?')) return response(200);
      if (options.method === 'POST' && options.path.endsWith('/agent')) {
        const body = JSON.parse(options.body ?? '{}') as { run_id?: string; session_id?: string };
        runId = body.run_id ?? '';
        expect(body.session_id).toBe('session-native');
        return response(202);
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    const spawn = vi.fn(fakeSpawn(child, []));
    const result = await runCrushManaged({
      cwd: process.cwd(),
      prompt: 'resume',
      nativeSessionId: 'session-native',
      spawnFn: spawn,
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined);

    expect(result.sessionId).toBe('session-native');
    expect(calls.some(call => call.method === 'POST' && call.path.endsWith('/sessions'))).toBe(false);
    expect(spawn.mock.calls[0]?.[1]).not.toContain('--continue');
  });

  it('rejects a resume response for a different native session id', async () => {
    const child = new FakeChild();
    const httpRequest: CrushHttpRequest = async options => {
      if (options.path === '/v1/health') return response(200);
      if (options.method === 'POST' && options.path === '/v1/workspaces') {
        return jsonResponse({ id: 'workspace-1' });
      }
      if (options.method === 'GET' && options.path.endsWith('/sessions/session-native')) {
        return jsonResponse({ id: 'session-other' });
      }
      if (options.path === '/v1/control') {
        child.exitCode = 0;
        return response(200);
      }
      throw new Error(`Unexpected request: ${options.method} ${options.path}`);
    };

    await expect(runCrushManaged({
      cwd: process.cwd(),
      prompt: 'resume exact only',
      nativeSessionId: 'session-native',
      spawnFn: fakeSpawn(child, []),
      httpRequest,
      transportFactory: async () => localTransport(),
    }, () => undefined)).rejects.toThrow(/different session/u);
  });

  it('rejects TCP transports before spawning', async () => {
    expect(() => assertCrushLocalTransport({
      serverHost: 'tcp://127.0.0.1:9876',
      socketPath: '127.0.0.1:9876',
    })).toThrow(/refuses TCP/u);

    const spawnFn = vi.fn<CrushSpawnFn>();
    await expect(runCrushManaged({
      cwd: process.cwd(),
      prompt: 'do not run',
      spawnFn,
      transportFactory: async () => ({
        serverHost: 'tcp://127.0.0.1:9876',
        socketPath: '127.0.0.1:9876',
      }),
    }, () => undefined)).rejects.toThrow(/refuses TCP/u);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
