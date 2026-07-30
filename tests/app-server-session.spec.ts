import { describe, expect, it, vi } from 'vitest';

import { AppServer } from '../src/app-server/index.js';
import type { ActoviqAgentClient } from '../src/runtime/agentClient.js';
import type { AgentSession } from '../src/runtime/agentSession.js';

describe('AppServer sessions', () => {
  it('initializes, creates, opens, and exposes session trees', async () => {
    const session = fakeSession('session-1');
    const sdk = {
      sessions: { list: vi.fn(async () => [{ id: 'session-1', title: 'One' }]) },
      sessionGraph: { roots: vi.fn(async () => [{ session: { id: 'session-1' }, children: [] }]) },
      createSession: vi.fn(async () => session),
      resumeSession: vi.fn(async () => session),
    } as unknown as ActoviqAgentClient;
    const server = new AppServer(sdk);

    const initialized = await server.handle(request('initialize'));
    expect(initialized.result).toMatchObject({
      protocolVersion: 1,
      capabilities: expect.arrayContaining(['sessions', 'checkpoints', 'goals']),
    });
    await expect(server.handle(request('session/list'))).resolves.toMatchObject({
      result: [{ id: 'session-1', title: 'One' }],
    });
    await expect(server.handle(request('session/tree'))).resolves.toMatchObject({
      result: [{ session: { id: 'session-1' } }],
    });

    const created = await server.handle(request('session/create', { title: 'Created' }));
    expect(created.result).toMatchObject({ id: 'session-1' });
    expect(sdk.createSession).toHaveBeenCalledWith({ title: 'Created', model: undefined });

    const opened = await server.handle(request('session/open', { sessionId: 'session-1' }));
    expect(opened.result).toMatchObject({ id: 'session-1' });
  });

  it('manages session goals through the shared GoalService', async () => {
    const session = fakeSession('session-goal');
    const sdk = { resumeSession: vi.fn(async () => session) } as unknown as ActoviqAgentClient;
    const server = new AppServer(sdk);

    const created = await server.handle(request('goal/create', {
      sessionId: session.id,
      objective: 'Ship editor integration',
      completionCriteria: 'Tests pass',
    }));
    expect(created.result).toMatchObject({
      objective: 'Ship editor integration',
      status: 'active',
      completionCriteria: 'Tests pass',
    });

    const paused = await server.handle(request('goal/transition', {
      sessionId: session.id,
      status: 'paused',
    }));
    expect(paused.result).toMatchObject({ ok: true, goal: { status: 'paused' } });

    const read = await server.handle(request('goal/get', { sessionId: session.id }));
    expect(read.result).toMatchObject({ status: 'paused' });
  });
});

function request(method: string, params: Record<string, unknown> = {}) {
  return { version: 1 as const, id: `request-${method}`, method, params };
}

function fakeSession(id: string): AgentSession {
  let metadata: Record<string, unknown> = {};
  const session = {
    id,
    get metadata() {
      return structuredClone(metadata);
    },
    snapshot: () => ({
      id,
      title: 'Session',
      model: 'test',
      messages: [],
      metadata: structuredClone(metadata),
    }),
    mergeMetadata: async (next: Record<string, unknown>) => {
      metadata = { ...metadata, ...next };
    },
    mutateMetadata: async (
      mutation: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      metadata = mutation(structuredClone(metadata));
      return structuredClone(metadata);
    },
  };
  return session as unknown as AgentSession;
}
