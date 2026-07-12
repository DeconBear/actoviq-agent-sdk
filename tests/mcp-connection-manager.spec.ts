import { describe, expect, it, vi } from 'vitest';

import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import type {
  StdioMcpServerDefinition,
  ToolExecutionContext,
} from '../src/types.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeMcpClient {
  connectCalls = 0;
  listCalls = 0;
  callCalls = 0;
  closeCalls = 0;
  toolName = 'ping';
  lastCallOptions: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number } | undefined;

  constructor(
    private readonly listGate?: Promise<void>,
    private readonly failToolCall = false,
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async listTools() {
    this.listCalls += 1;
    await this.listGate;
    return {
      tools: [{
        name: this.toolName,
        description: 'Ping the fake server.',
        inputSchema: { type: 'object', properties: {} },
      }],
    };
  }

  async callTool(
    _params: unknown,
    _schema: unknown,
    options: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number } = {},
  ) {
    this.callCalls += 1;
    this.lastCallOptions = options;
    if (this.failToolCall) {
      throw new Error('transport failed after dispatch');
    }
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    return { content: [{ type: 'text', text: 'pong' }] };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function server(name: string, envValue = 'one'): StdioMcpServerDefinition {
  return {
    kind: 'stdio',
    name,
    command: 'fake-mcp',
    args: ['--serve'],
    env: { TOKEN: envValue },
    cwd: `C:/workspace/${envValue}`,
  };
}

function toolContext(signal?: AbortSignal): ToolExecutionContext {
  return {
    signal,
    runId: 'run-1',
    cwd: 'C:/workspace',
    metadata: {},
    prompt: 'ping',
    iteration: 1,
  };
}

describe('McpConnectionManager', () => {
  it('discovers servers in parallel and reuses the TTL catalog', async () => {
    const gate = deferred<void>();
    const clients: FakeMcpClient[] = [];
    const manager = new McpConnectionManager(
      { name: 'test', version: '1' },
      {
        catalogTtlMs: 10_000,
        clientFactory: () => {
          const client = new FakeMcpClient(gate.promise);
          clients.push(client);
          return client as any;
        },
      },
    );

    const first = manager.resolveToolAdapters([], [server('a'), server('b'), server('c')]);
    await vi.waitFor(() => {
      expect(clients).toHaveLength(3);
      expect(clients.every(client => client.listCalls === 1)).toBe(true);
    });
    gate.resolve();
    await expect(first).resolves.toHaveLength(3);

    await expect(manager.resolveToolAdapters([], [server('a'), server('b'), server('c')]))
      .resolves.toHaveLength(3);
    expect(clients).toHaveLength(3);
    expect(clients.every(client => client.listCalls === 1)).toBe(true);
    await manager.closeAll();
  });

  it('uses env/cwd in the fingerprint and closes a superseded connection', async () => {
    const clients: FakeMcpClient[] = [];
    const manager = new McpConnectionManager(
      { name: 'test', version: '1' },
      {
        clientFactory: () => {
          const client = new FakeMcpClient();
          clients.push(client);
          return client as any;
        },
      },
    );

    const firstSecret = 'mcp-secret-first-7f5d';
    const secondSecret = 'mcp-secret-second-91ac';
    await manager.resolveToolAdapters([], [server('same', firstSecret)]);
    await manager.resolveToolAdapters([], [server('same', secondSecret)]);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.closeCalls).toBe(1);
    const connectionState = manager as unknown as {
      connections: Map<string, unknown>;
    };
    const serialized = JSON.stringify([...connectionState.connections.entries()]);
    expect([...connectionState.connections.keys()]).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(serialized).not.toContain(firstSecret);
    expect(serialized).not.toContain(secondSecret);
    await manager.closeAll();
  });

  it('refreshes a changed catalog after its TTL expires', async () => {
    const client = new FakeMcpClient();
    const manager = new McpConnectionManager(
      { name: 'test', version: '1' },
      { catalogTtlMs: 1, clientFactory: () => client as any },
    );

    const first = await manager.resolveToolAdapters([], [server('catalog')]);
    expect(first.map(tool => tool.sourceName)).toEqual(['ping']);
    client.toolName = 'pong';
    await new Promise(resolve => setTimeout(resolve, 5));
    const refreshed = await manager.resolveToolAdapters([], [server('catalog')]);

    expect(refreshed.map(tool => tool.sourceName)).toEqual(['pong']);
    expect(client.listCalls).toBe(2);
    await manager.closeAll();
  });

  it('passes signal and timeout to calls and never replays a failed tool call', async () => {
    const clients: FakeMcpClient[] = [];
    const manager = new McpConnectionManager(
      { name: 'test', version: '1' },
      {
        requestTimeoutMs: 1_234,
        clientFactory: () => {
          const client = new FakeMcpClient(undefined, clients.length === 0);
          clients.push(client);
          return client as any;
        },
      },
    );
    const [adapter] = await manager.resolveToolAdapters([], [server('failure')]);
    const controller = new AbortController();

    await expect(adapter!.execute({}, toolContext(controller.signal))).rejects.toThrow(
      'transport failed after dispatch',
    );
    expect(clients[0]?.callCalls).toBe(1);
    expect(clients[0]?.lastCallOptions).toMatchObject({
      signal: controller.signal,
      timeout: 1_234,
      maxTotalTimeout: 1_234,
    });
    expect(clients[0]?.closeCalls).toBe(1);

    await manager.resolveToolAdapters([], [server('failure')]);
    expect(clients).toHaveLength(2);
    await manager.closeAll();
  });
});
