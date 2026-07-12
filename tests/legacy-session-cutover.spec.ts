import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentSpec } from '../src/core/index.js';
import { SqliteRuntimeSessionAdapter, SqliteStorageV2 } from '../src/node/index.js';
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  ModelRegistry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import { AgentRuntime, RuntimeServices } from '../src/runtime-v2/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const resolvedModel: ResolvedModel = {
  providerId: 'cutover',
  modelId: 'model',
  ref: { provider: 'cutover', model: 'model' },
};

class CutoverProvider implements ModelProvider {
  readonly id = 'cutover';
  readonly requests: ModelRequest[] = [];

  async resolve(): Promise<ResolvedModel> { return resolvedModel; }
  async capabilities() { return ANTHROPIC_MESSAGES_CAPABILITIES; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      id: 'next-response',
      model: resolvedModel,
      finishReason: 'stop',
      output: [{ type: 'text', role: 'assistant', text: 'continued' }],
      usage: {
        requests: 1, inputTokens: 8, outputTokens: 1, totalTokens: 9,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        audioInputTokens: 0, audioOutputTokens: 0, costUsd: 0,
      },
    };
  }
  stream(): never { throw new Error('not used'); }
}

describe('JSON-v1 runtime cutover', () => {
  it('migrates legacy content and immediately continues the session with Runtime v2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-cutover-'));
    roots.push(root);
    const source = path.join(root, 'legacy');
    await mkdir(path.join(source, 'sessions'), { recursive: true });
    await writeFile(path.join(source, 'sessions', 'session-a.json'), JSON.stringify({
      version: 1,
      revision: 4,
      id: 'session-a',
      title: 'Legacy session',
      titleSource: 'manual',
      model: 'old-model',
      metadata: {},
      tags: [],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      messages: [
        { role: 'user', content: 'old question' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'old answer' },
            { type: 'thinking', thinking: 'safe summary', signature: 'must-not-migrate' },
            { type: 'tool_use', id: 'call-1', name: 'lookup', input: { query: 'x' } },
            { type: 'tool_result', tool_use_id: 'call-1', content: 'tool output' },
            { type: 'future_provider_block', value: { preserved: true } },
          ],
        },
      ],
      runs: [{ runId: 'legacy-run', text: 'must not enter the model transcript' }],
    }), 'utf8');

    const storage = await SqliteStorageV2.open({ filename: path.join(root, 'state.sqlite') });
    await storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a',
      sourceDirectory: source,
      backupDirectory: path.join(root, 'backup'),
    });
    const adapter = new SqliteRuntimeSessionAdapter({ store: storage.sessions });
    const migrated = await adapter.load({ tenantId: 'tenant-a', sessionId: 'session-a' });
    expect(migrated.items.map(item => item.type)).toEqual([
      'text', 'text', 'reasoning', 'tool_call', 'tool_result',
    ]);
    expect(migrated.items).toContainEqual(expect.objectContaining({
      type: 'tool_call', id: 'call-1', name: 'lookup', input: { query: 'x' },
    }));
    expect(JSON.stringify(migrated.items)).not.toContain('must-not-migrate');
    expect(JSON.stringify(migrated.items)).not.toContain('must not enter the model transcript');
    const durable = await storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'session-a', afterSequence: 0,
    });
    expect(durable.items).toContainEqual(expect.objectContaining({
      kind: 'raw',
      payload: expect.objectContaining({ type: 'raw', provider: 'legacy' }),
    }));

    const provider = new CutoverProvider();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      services: new RuntimeServices({ sessions: { factory: () => adapter } }),
    });
    const agent: AgentSpec = {
      id: 'chat', name: 'Chat', instructions: 'Continue safely.', model: 'cutover:model',
    };
    const result = await runtime.run(agent, 'new question', {
      tenantId: 'tenant-a', sessionId: 'session-a',
    });

    expect(result.output).toBe('continued');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.input).toContainEqual(expect.objectContaining({
      type: 'text', role: 'user', text: 'old question',
    }));
    expect(provider.requests[0]?.input).toContainEqual(expect.objectContaining({
      type: 'text', role: 'user', text: 'new question',
    }));
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain('must not enter the model transcript');

    await runtime.close();
    await storage.close();
  });

  it('reads databases produced by the early preview and excludes old run records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-cutover-preview-'));
    roots.push(root);
    const storage = await SqliteStorageV2.open({ filename: path.join(root, 'state.sqlite') });
    await storage.sessions.create({ tenantId: 'tenant-a', sessionId: 'preview' });
    await storage.sessions.append({
      tenantId: 'tenant-a', sessionId: 'preview', expectedRevision: 0,
      items: [
        { itemId: 'message', kind: 'message', payload: { role: 'user', content: 'legacy' } },
        { itemId: 'run', kind: 'run', payload: { text: 'audit only' } },
      ],
    });
    const adapter = new SqliteRuntimeSessionAdapter({ store: storage.sessions });
    await expect(adapter.load({ tenantId: 'tenant-a', sessionId: 'preview' }))
      .resolves.toMatchObject({ items: [{ type: 'text', role: 'user', text: 'legacy' }] });
    await storage.close();
  });

  it('rejects an invalid legacy message before backup or target writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-cutover-invalid-'));
    roots.push(root);
    const source = path.join(root, 'legacy');
    await mkdir(path.join(source, 'sessions'), { recursive: true });
    await writeFile(path.join(source, 'sessions', 'bad.json'), JSON.stringify({
      version: 1, id: 'bad', messages: [{ role: 'system', content: 'invalid' }], runs: [],
    }), 'utf8');
    const storage = await SqliteStorageV2.open({ filename: path.join(root, 'state.sqlite') });
    await expect(storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a', sourceDirectory: source,
      backupDirectory: path.join(root, 'backup'),
    })).rejects.toMatchObject({ code: 'STORAGE_DATA_INVALID' });
    await expect(storage.sessions.get({ tenantId: 'tenant-a', sessionId: 'bad' }))
      .resolves.toBeUndefined();
    await storage.close();
  });
});
