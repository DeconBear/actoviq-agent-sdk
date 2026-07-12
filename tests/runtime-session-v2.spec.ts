import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSpec, InputItem } from '../src/core/index.js';
import { SqliteRuntimeSessionAdapter, SqliteStorageV2 } from '../src/node/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import {
  AgentRuntime,
  RuntimeServices,
  type RuntimeSessionStore,
} from '../src/runtime-v2/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const model: ResolvedModel = {
  providerId: 'fake', modelId: 'model', ref: { provider: 'fake', model: 'model' },
};

function usage() {
  return {
    requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    audioInputTokens: 0, audioOutputTokens: 0, costUsd: 0,
  };
}

class SessionProvider implements ModelProvider {
  readonly id = 'fake';
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responder: (index: number) => Promise<string> | string) {}
  async resolve() { return model; }
  async capabilities() { return MINIMAL_MODEL_CAPABILITIES; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.push(request) - 1;
    return {
      id: `response-${index}`, model, finishReason: 'stop', usage: usage(),
      output: [{ type: 'text', role: 'assistant', text: await this.responder(index) }],
    };
  }
  stream(): never { throw new Error('not used'); }
}

class MemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly records = new Map<string, {
    items: readonly InputItem[];
    revision: number;
  }>();

  get size(): number {
    return this.records.size;
  }

  async load(request: { tenantId: string; sessionId: string }) {
    const record = this.records.get(`${request.tenantId}\u0000${request.sessionId}`);
    return record
      ? { items: record.items, revision: String(record.revision) }
      : { items: [], revision: '0' };
  }

  async append(request: {
    tenantId: string;
    sessionId: string;
    items: readonly InputItem[];
    expectedRevision: string;
  }) {
    const key = `${request.tenantId}\u0000${request.sessionId}`;
    const record = this.records.get(key) ?? { items: [], revision: 0 };
    if (String(record.revision) !== request.expectedRevision) {
      throw new Error(`Revision conflict for ${request.sessionId}`);
    }
    const revision = record.revision + 1;
    this.records.set(key, { items: [...record.items, ...request.items], revision });
    return { revision: String(revision) };
  }

  close(): void {}
}

class BlockingSessionProvider implements ModelProvider {
  readonly id = 'fake';
  calls = 0;
  active = 0;
  maxActive = 0;

  constructor(private readonly gate: Promise<void>) {}

  async resolve() { return model; }
  async capabilities() { return MINIMAL_MODEL_CAPABILITIES; }
  async generate(request: ModelRequest, context: { signal?: AbortSignal }): Promise<ModelResponse> {
    const index = this.calls;
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.gate;
      context.signal?.throwIfAborted();
      return {
        id: `bounded-response-${index}`,
        model,
        finishReason: 'stop',
        usage: usage(),
        output: [{ type: 'text', role: 'assistant', text: `reply-${index}` }],
      };
    } finally {
      this.active -= 1;
    }
  }
  stream(): never { throw new Error('not used'); }
}

const agent: AgentSpec = {
  id: 'chat', name: 'Chat', instructions: 'Be concise.', model: 'fake:model',
};

describe('AgentRuntime v2 sessions', () => {
  it('loads committed history lazily and appends only the new turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-session-v2-'));
    roots.push(root);
    const storage = await SqliteStorageV2.open({ filename: path.join(root, 'session.sqlite') });
    const factory = vi.fn(() => new SqliteRuntimeSessionAdapter({ store: storage.sessions }));
    const services = new RuntimeServices({ sessions: { factory } });
    const provider = new SessionProvider(index => index === 0 ? 'first' : 'second');
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]), services });

    await runtime.run(agent, 'one', { tenantId: 'tenant-a', sessionId: 'session-a' });
    await runtime.run(agent, 'two', { tenantId: 'tenant-a', sessionId: 'session-a' });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(provider.requests[1]?.input).toEqual([
      { type: 'text', role: 'system', text: 'Be concise.' },
      { type: 'text', role: 'user', text: 'one' },
      { type: 'text', role: 'assistant', text: 'first' },
      { type: 'text', role: 'user', text: 'two' },
    ]);
    const stored = await storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'session-a', afterSequence: 0,
    });
    expect(stored.session.revision).toBe(2);
    expect(stored.items.map(item => item.kind)).toEqual(['text', 'text', 'text', 'text']);
    await runtime.close();
    await storage.close();
  });

  it('serializes concurrent turns for the same tenant/session before model execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-session-serial-'));
    roots.push(root);
    const storage = await SqliteStorageV2.open({ filename: path.join(root, 'session.sqlite') });
    const services = new RuntimeServices({
      sessions: { factory: () => new SqliteRuntimeSessionAdapter({ store: storage.sessions }) },
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new SessionProvider(async index => {
      if (index === 0) await gate;
      return `reply-${index}`;
    });
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]), services });

    const first = runtime.run(agent, 'first', { tenantId: 'tenant-a', sessionId: 'same' });
    const second = runtime.run(agent, 'second', { tenantId: 'tenant-a', sessionId: 'same' });
    while (provider.requests.length === 0) await Promise.resolve();
    expect(provider.requests).toHaveLength(1);
    release();
    await Promise.all([first, second]);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.input).toContainEqual({
      type: 'text', role: 'assistant', text: 'reply-0',
    });
    await runtime.close();
    await storage.close();
  });

  it('bounds 1000 independent session runs with the runtime semaphore', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new BlockingSessionProvider(gate);
    const store = new MemoryRuntimeSessionStore();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      maxConcurrentRuns: 8,
      services: new RuntimeServices({ sessions: { factory: () => store } }),
    });

    const runs = Array.from({ length: 1_000 }, (_, index) => runtime.run(agent, `turn-${index}`, {
      tenantId: 'tenant-a',
      sessionId: `session-${index}`,
    }));
    await vi.waitFor(() => expect(provider.active).toBe(8), { timeout: 5_000 });
    expect(provider.calls).toBe(8);

    release();
    await Promise.all(runs);
    expect(provider.calls).toBe(1_000);
    expect(provider.maxActive).toBe(8);
    expect(store.size).toBe(1_000);
    await runtime.close();
  }, 15_000);

  it('removes an aborted run while it waits for a runtime permit', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new BlockingSessionProvider(gate);
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      maxConcurrentRuns: 1,
    });

    const first = runtime.run(agent, 'first');
    await vi.waitFor(() => expect(provider.active).toBe(1));
    const controller = new AbortController();
    const second = runtime.run(agent, 'second', { signal: controller.signal });
    controller.abort(new Error('cancelled while queued'));

    await expect(second).resolves.toMatchObject({ status: 'cancelled' });
    expect(provider.calls).toBe(1);
    release();
    await first;
    await runtime.close();
  });

  it('rejects a non-positive runtime concurrency limit at construction', () => {
    const provider = new SessionProvider(() => 'unused');
    expect(() => new AgentRuntime({
      models: new ModelRegistry([provider]),
      maxConcurrentRuns: 0,
    })).toThrow('maxConcurrentRuns must be a positive safe integer');
  });
});
