import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { getHadamardProjectSessionDirectory } from '../src/config/projectSessionDirectory.js';
import { AgentExecutionStore } from '../src/storage/agentExecutionStore.js';
import { SessionStore } from '../src/storage/sessionStore.js';
import type {
  AgentExecutionProjectView,
  AgentExecutionRootView,
} from '../src/ui/agentExecutionView.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function api<T>(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const url = new URL(requestPath.replace(/^\/+/u, ''), server.url);
  const response = await fetch(url, {
    ...init,
    headers: { 'x-hadamard-token': server.token, ...init.headers },
  });
  return {
    status: response.status,
    body: await response.json() as T,
  };
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 6, 16, 0, 0, second)).toISOString();
}

async function seedActiveExecution(store: AgentExecutionStore, cwd: string): Promise<void> {
  await store.upsertEvent({
    type: 'thread.started',
    eventId: 'root-a-started',
    rootExecutionId: 'root-a',
    occurredAt: at(0),
    executionId: 'root-a',
    sessionId: 'main-session',
    agentName: 'Main Agent',
    runtime: 'hadamard',
    model: 'test-model',
    cwd,
    agentStatus: 'running',
    threadStatus: 'active',
  });
  await store.upsertEvent({
    type: 'turn.started',
    eventId: 'root-a-turn',
    rootExecutionId: 'root-a',
    occurredAt: at(1),
    executionId: 'root-a',
    sessionId: 'main-session',
    runId: 'run-root-a',
  });
  await store.upsertEvent({
    type: 'plan.updated',
    eventId: 'root-a-plan',
    rootExecutionId: 'root-a',
    occurredAt: at(2),
    executionId: 'root-a',
    sessionId: 'main-session',
    plan: [
      { id: 'inspect', title: 'Inspect API state', status: 'in_progress' },
      { id: 'verify', title: 'Verify the GUI', status: 'pending' },
    ],
  });
  await store.upsertEvent({
    type: 'thread.started',
    eventId: 'child-a-started',
    rootExecutionId: 'root-a',
    occurredAt: at(3),
    executionId: 'child-a',
    sessionId: 'agent-child-session',
    parentExecutionId: 'root-a',
    parentSessionId: 'main-session',
    canonicalPath: '/root/reviewer',
    spawnOrder: 1,
    agentName: 'Reviewer',
    nickname: 'reviewer',
    runtime: 'hadamard',
    model: 'test-model',
    cwd,
    agentStatus: 'running',
    threadStatus: 'active',
  });
  await store.upsertEvent({
    type: 'edge.started',
    eventId: 'child-a-edge',
    rootExecutionId: 'root-a',
    occurredAt: at(4),
    callId: 'delegate-child-a',
    kind: 'delegate',
    sourceExecutionId: 'root-a',
    targetExecutionId: 'child-a',
    sourceSessionId: 'main-session',
    targetSessionId: 'agent-child-session',
    summary: 'Review the project API',
  });
  await store.upsertEvent({
    type: 'thread.status',
    eventId: 'child-a-waiting',
    rootExecutionId: 'root-a',
    occurredAt: at(5),
    executionId: 'child-a',
    sessionId: 'agent-child-session',
    agentStatus: 'interrupted',
    threadStatus: 'idle',
  });
  await store.upsertEvent({
    type: 'activity',
    eventId: 'child-a-waiting-activity',
    rootExecutionId: 'root-a',
    occurredAt: at(6),
    executionId: 'child-a',
    sessionId: 'agent-child-session',
    activity: {
      kind: 'waiting',
      summary: 'Waiting for the network to return',
      startedAt: at(6),
    },
  });
  await store.upsertEvent({
    type: 'thread.started',
    eventId: 'root-a-history-started',
    rootExecutionId: 'root-a-history',
    occurredAt: at(7),
    executionId: 'root-a-history',
    sessionId: 'main-session',
    agentName: 'Older completed turn',
    runtime: 'claude',
    model: 'test-model',
    cwd,
    agentStatus: 'running',
    threadStatus: 'active',
  });
  await store.upsertEvent({
    type: 'activity',
    eventId: 'root-a-history-activity',
    rootExecutionId: 'root-a-history',
    occurredAt: at(8),
    executionId: 'root-a-history',
    sessionId: 'main-session',
    activity: {
      kind: 'message',
      summary: 'Stale completed activity',
      startedAt: at(8),
    },
  });
  await store.upsertEvent({
    type: 'turn.completed',
    eventId: 'root-a-history-completed',
    rootExecutionId: 'root-a-history',
    occurredAt: at(9),
    executionId: 'root-a-history',
    sessionId: 'main-session',
    runId: 'run-root-a-history',
    outcome: 'completed',
    result: 'Historical turn complete.',
  });
}

async function seedCompletedExecution(store: AgentExecutionStore, cwd: string): Promise<void> {
  await store.upsertEvent({
    type: 'thread.started',
    eventId: 'root-b-started',
    rootExecutionId: 'root-b',
    occurredAt: at(0),
    executionId: 'root-b',
    sessionId: 'other-main-session',
    agentName: 'Other Project Agent',
    runtime: 'hadamard',
    model: 'test-model',
    cwd,
    agentStatus: 'running',
    threadStatus: 'active',
  });
  await store.upsertEvent({
    type: 'turn.started',
    eventId: 'root-b-turn',
    rootExecutionId: 'root-b',
    occurredAt: at(1),
    executionId: 'root-b',
    sessionId: 'other-main-session',
    runId: 'run-root-b',
  });
  await store.upsertEvent({
    type: 'turn.completed',
    eventId: 'root-b-completed',
    rootExecutionId: 'root-b',
    occurredAt: at(2),
    executionId: 'root-b',
    sessionId: 'other-main-session',
    runId: 'run-root-b',
    outcome: 'completed',
    result: 'Other project complete.',
  });
}

function expectNoInternalEventState(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) expectNoInternalEventState(item);
    return;
  }
  const record = value as Record<string, unknown>;
  expect(record).not.toHaveProperty('events');
  expect(record).not.toHaveProperty('seenEventIds');
  for (const child of Object.values(record)) expectNoInternalEventState(child);
}

describe('GUI agent execution API', () => {
  it('isolates project execution views and keeps agent sessions out of chat lists', async () => {
    const root = await tempRoot('hadamard-gui-agent-executions-');
    const homeDir = path.join(root, 'home');
    const workA = path.join(root, 'project-a');
    const workB = path.join(root, 'project-b');
    const configPath = path.join(homeDir, '.hadamard', 'settings.json');
    await Promise.all([
      mkdir(workA, { recursive: true }),
      mkdir(workB, { recursive: true }),
      mkdir(path.dirname(configPath), { recursive: true }),
    ]);
    await writeFile(configPath, JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const projectRootA = getHadamardProjectSessionDirectory(workA, homeDir);
    const projectRootB = getHadamardProjectSessionDirectory(workB, homeDir);
    await seedActiveExecution(new AgentExecutionStore(projectRootA), workA);
    await seedCompletedExecution(new AgentExecutionStore(projectRootB), workB);

    const sessionStore = new SessionStore(projectRootA);
    await sessionStore.create({
      id: 'main-session',
      title: 'Visible main chat',
      model: 'test-model',
      kind: 'main',
      metadata: { __hadamardWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'Keep this main chat visible.' }],
    });
    await sessionStore.create({
      id: 'agent-child-session',
      title: 'Hidden child agent chat',
      model: 'test-model',
      kind: 'agent',
      parentSessionId: 'main-session',
      metadata: { __hadamardWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'This belongs in the Agent view.' }],
    });
    await sessionStore.create({
      id: 'history-session',
      title: 'Earlier project conversation',
      model: 'test-model',
      kind: 'main',
      metadata: { __hadamardWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'Keep this conversation in the Agent monitor.' }],
    });
    await sessionStore.create({
      id: 'manager-session',
      title: 'Manager',
      model: 'test-model',
      kind: 'manager',
      metadata: { __hadamardWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'Keep this manager conversation in its dedicated panel.' }],
    });
    await sessionStore.create({
      id: 'archived-session',
      title: 'Archived project conversation',
      model: 'test-model',
      kind: 'main',
      metadata: { __hadamardWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'Do not show this archived conversation.' }],
    });

    const server = await startHadamardGuiServer({
      workDir: workA,
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const archived = await api<{ ok: boolean }>(server, '/api/session/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'archived-session' }),
      });
      expect(archived.status).toBe(200);

      const activeSession = await api<{ session: { id: string } | null }>(
        server,
        '/api/session/active',
      );
      expect(activeSession.status).toBe(200);
      expect(activeSession.body.session?.id).toBeTruthy();

      const listA = await api<AgentExecutionProjectView & {
        conversations: Array<{
          id: string;
          title: string;
          kind?: string;
          isRunning: boolean;
          isWaiting: boolean;
          isCurrent: boolean;
          lifecycle: string;
          displayName: string;
          currentActivity: { summary?: string } | null;
        }>;
        runningConversationCount: number;
        waitingConversationCount: number;
      }>(
        server,
        `/api/agent-executions?path=${encodeURIComponent(workA)}`,
      );
      expect(listA.status).toBe(200);
      expect(listA.body.active.map(item => item.rootExecutionId)).toEqual(['root-a']);
      expect(listA.body.completed.map(item => item.rootExecutionId)).toEqual(['root-a-history']);
      expect(listA.body).toMatchObject({
        totalExecutionCount: 2,
        totalAgentCount: 3,
        runningConversationCount: 1,
        waitingConversationCount: 1,
      });
      expect(listA.body.conversations.map(item => item.id)).toEqual(expect.arrayContaining([
        'main-session',
        'agent-child-session',
        'history-session',
        'manager-session',
      ]));
      expect(listA.body.conversations.map(item => item.id)).not.toContain('archived-session');
      expect(listA.body.conversations.find(item => item.id === 'agent-child-session')).toMatchObject({
        kind: 'agent',
        isWaiting: true,
        lifecycle: 'waiting',
      });
      expect(listA.body.conversations.find(item => item.id === 'main-session')).toMatchObject({
        isRunning: true,
        isWaiting: false,
        lifecycle: 'running',
        currentActivity: null,
      });
      expect(listA.body.conversations.find(item => item.id === 'manager-session')).toMatchObject({
        kind: 'manager',
        displayName: 'Project Manager',
      });
      expectNoInternalEventState(listA.body);

      const listB = await api<AgentExecutionProjectView>(
        server,
        `/api/agent-executions?path=${encodeURIComponent(workB)}`,
      );
      expect(listB.status).toBe(200);
      expect(listB.body.active).toEqual([]);
      expect(listB.body.waiting).toEqual([]);
      expect(listB.body.completed.map(item => item.rootExecutionId)).toEqual(['root-b']);
      expect(listB.body.completed.map(item => item.rootExecutionId)).not.toContain('root-a');
      expectNoInternalEventState(listB.body);

      const detail = await api<AgentExecutionRootView>(
        server,
        `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=root-a`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        rootExecutionId: 'root-a',
        rootSessionId: 'main-session',
        nodeCount: 2,
        subagentCount: 1,
        edgeCount: 1,
        edges: [
          expect.objectContaining({
            callId: 'delegate-child-a',
            kind: 'delegate',
            sourceExecutionId: 'root-a',
            targetExecutionId: 'child-a',
          }),
        ],
        root: {
          sessionId: 'main-session',
          children: [
            expect.objectContaining({
              id: 'child-a',
              sessionId: 'agent-child-session',
              parentExecutionId: 'root-a',
            }),
          ],
        },
      });
      expectNoInternalEventState(detail.body);

      const missingPath = await api<{ error: string }>(server, '/api/agent-executions');
      expect(missingPath.status).toBe(400);
      const invalidPath = await api<{ error: string }>(
        server,
        `/api/agent-executions?path=${encodeURIComponent(path.join(root, 'missing-project'))}`,
      );
      expect(invalidPath.status).toBe(400);
      const missingRoot = await api<{ error: string }>(
        server,
        `/api/agent-execution?path=${encodeURIComponent(workA)}`,
      );
      expect(missingRoot.status).toBe(400);
      const invalidRoot = await api<{ error: string }>(
        server,
        `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=${encodeURIComponent('../escape')}`,
      );
      expect(invalidRoot.status).toBe(400);
      const unknownRoot = await api<{ error: string }>(
        server,
        `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=missing-root`,
      );
      expect(unknownRoot.status).toBe(404);
      const otherProjectRoot = await api<{ error: string }>(
        server,
        `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=root-b`,
      );
      expect(otherProjectRoot.status).toBe(404);

      const state = await api<{
        sessions: Array<{ id: string; kind?: string }>;
        projects: Array<{
          path: string;
          sessionCount: number;
          recentSessions: Array<{ id: string }>;
        }>;
      }>(server, '/api/state');
      expect(state.status).toBe(200);
      expect(state.body.sessions.map(item => item.id)).toContain('main-session');
      expect(state.body.sessions.map(item => item.id)).not.toContain('agent-child-session');
      const projectA = state.body.projects.find(item => path.resolve(item.path) === path.resolve(workA));
      expect(projectA).toMatchObject({ sessionCount: 2 });
      expect(projectA?.recentSessions.map(item => item.id)).toEqual(expect.arrayContaining([
        'main-session',
        'history-session',
      ]));
    } finally {
      await server.close();
    }
  });

  it('keeps paths with colliding legacy slugs isolated at list and detail level', async () => {
    const root = await tempRoot('hadamard-gui-agent-collision-');
    const homeDir = path.join(root, 'home');
    const workA = path.join(root, 'a-b');
    const workB = path.join(root, 'a_b');
    const configPath = path.join(homeDir, '.hadamard', 'settings.json');
    await Promise.all([
      mkdir(workA, { recursive: true }),
      mkdir(workB, { recursive: true }),
      mkdir(path.dirname(configPath), { recursive: true }),
    ]);
    await writeFile(configPath, JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const projectRootA = getHadamardProjectSessionDirectory(workA, homeDir);
    const projectRootB = getHadamardProjectSessionDirectory(workB, homeDir);
    expect(projectRootA).not.toBe(projectRootB);
    await seedActiveExecution(new AgentExecutionStore(projectRootA), workA);
    await seedCompletedExecution(new AgentExecutionStore(projectRootB), workB);

    const server = await startHadamardGuiServer({
      workDir: workA,
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const [listA, listB] = await Promise.all([
        api<AgentExecutionProjectView>(
          server,
          `/api/agent-executions?path=${encodeURIComponent(workA)}`,
        ),
        api<AgentExecutionProjectView>(
          server,
          `/api/agent-executions?path=${encodeURIComponent(workB)}`,
        ),
      ]);
      expect(listA.status).toBe(200);
      expect(listB.status).toBe(200);
      expect([
        ...listA.body.active,
        ...listA.body.waiting,
        ...listA.body.completed,
      ].map(item => item.rootExecutionId)).toEqual(['root-a', 'root-a-history']);
      expect([
        ...listB.body.active,
        ...listB.body.waiting,
        ...listB.body.completed,
      ].map(item => item.rootExecutionId)).toEqual(['root-b']);

      const [detailA, detailB, crossA, crossB] = await Promise.all([
        api<AgentExecutionRootView>(
          server,
          `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=root-a`,
        ),
        api<AgentExecutionRootView>(
          server,
          `/api/agent-execution?path=${encodeURIComponent(workB)}&rootExecutionId=root-b`,
        ),
        api<{ error: string }>(
          server,
          `/api/agent-execution?path=${encodeURIComponent(workA)}&rootExecutionId=root-b`,
        ),
        api<{ error: string }>(
          server,
          `/api/agent-execution?path=${encodeURIComponent(workB)}&rootExecutionId=root-a`,
        ),
      ]);
      expect(detailA.status).toBe(200);
      expect(detailA.body.rootExecutionId).toBe('root-a');
      expect(detailB.status).toBe(200);
      expect(detailB.body.rootExecutionId).toBe('root-b');
      expect(crossA.status).toBe(404);
      expect(crossB.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
