import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentExecutionTree,
  MAX_AGENT_EXECUTION_EVENT_HISTORY,
  reduceAgentExecutionEvent,
  type AgentExecutionEvent,
  type AgentExecutionSnapshot,
} from '../src/runtime/agentExecution.js';
import { AgentExecutionStore } from '../src/storage/agentExecutionStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<{ store: AgentExecutionStore; root: string; temp: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'actoviq-agent-execution-'));
  tempDirs.push(temp);
  const root = path.join(temp, 'sessions-root');
  return { store: new AgentExecutionStore(root), root, temp };
}

function at(index: number): string {
  return new Date(Date.UTC(2026, 6, 16, 0, 0, index)).toISOString();
}

function rootStarted(eventId = 'event-root'): AgentExecutionEvent {
  return {
    type: 'thread.started',
    eventId,
    rootExecutionId: 'root-execution',
    occurredAt: at(0),
    executionId: 'root-execution',
    sessionId: 'session-root',
    agentName: 'Main Agent',
    runtime: 'hadamard',
    model: 'test-model',
    cwd: 'C:/workspace',
  };
}

describe('AgentExecutionStore', () => {
  it('persists a parent-child tree and upserts collaboration edges by callId', async () => {
    const { store } = await createStore();
    await store.upsertEvent(rootStarted());
    await store.upsertEvent({
      type: 'thread.started',
      eventId: 'event-child',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'child-execution',
      sessionId: 'session-child',
      parentExecutionId: 'root-execution',
      parentSessionId: 'session-root',
      agentName: 'Code Reviewer',
      runtime: 'codex',
      model: 'gpt-5',
      cwd: 'C:/workspace',
    });
    await store.upsertEvent({
      type: 'edge.started',
      eventId: 'event-edge-start',
      rootExecutionId: 'root-execution',
      occurredAt: at(2),
      callId: 'call-1',
      kind: 'delegate',
      sourceExecutionId: 'root-execution',
      targetExecutionId: 'child-execution',
      sourceSessionId: 'session-root',
      targetSessionId: 'session-child',
      summary: 'Review the execution store',
    });
    await store.upsertEvent({
      type: 'edge.started',
      eventId: 'event-edge-retry',
      rootExecutionId: 'root-execution',
      occurredAt: at(3),
      callId: 'call-1',
      kind: 'delegate',
      sourceExecutionId: 'root-execution',
      targetExecutionId: 'child-execution',
    });
    const snapshot = await store.upsertEvent({
      type: 'edge.completed',
      eventId: 'event-edge-end',
      rootExecutionId: 'root-execution',
      occurredAt: at(4),
      callId: 'call-1',
      result: 'Reviewed',
    });

    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        status: 'completed',
        sourceExecutionId: 'root-execution',
        targetExecutionId: 'child-execution',
        result: 'Reviewed',
      }),
    ]);
    const child = await store.get('child-execution');
    expect(child).toMatchObject({
      parentExecutionId: 'root-execution',
      canonicalPath: '/root/code-reviewer',
      kind: 'subagent',
      runtime: 'codex',
    });
    const tree = createAgentExecutionTree(snapshot);
    expect(tree.root?.node.canonicalPath).toBe('/root');
    expect(tree.root?.children.map((entry) => entry.node.id)).toEqual(['child-execution']);
    expect(tree.root?.outgoingEdges).toHaveLength(1);
  });

  it('keeps the first edge terminal outcome when conflicting events arrive later', async () => {
    const { store } = await createStore();
    await store.upsertEvent(rootStarted());
    await store.upsertEvent({
      type: 'thread.started',
      eventId: 'terminal-child',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'terminal-child',
      sessionId: 'terminal-child-session',
      parentExecutionId: 'root-execution',
      agentName: 'Terminal Child',
    });
    for (const callId of ['complete-first', 'fail-first']) {
      await store.upsertEvent({
        type: 'edge.started',
        eventId: `${callId}-started`,
        rootExecutionId: 'root-execution',
        occurredAt: at(2),
        callId,
        kind: 'message',
        sourceExecutionId: 'root-execution',
        targetExecutionId: 'terminal-child',
      });
    }
    await store.upsertEvent({
      type: 'edge.completed',
      eventId: 'complete-first-terminal',
      rootExecutionId: 'root-execution',
      occurredAt: at(3),
      callId: 'complete-first',
      result: 'done',
    });
    await store.upsertEvent({
      type: 'edge.failed',
      eventId: 'complete-first-conflict',
      rootExecutionId: 'root-execution',
      occurredAt: at(4),
      callId: 'complete-first',
      error: 'late failure',
    });
    await store.upsertEvent({
      type: 'edge.failed',
      eventId: 'fail-first-terminal',
      rootExecutionId: 'root-execution',
      occurredAt: at(5),
      callId: 'fail-first',
      error: 'boom',
    });
    const snapshot = await store.upsertEvent({
      type: 'edge.completed',
      eventId: 'fail-first-conflict',
      rootExecutionId: 'root-execution',
      occurredAt: at(6),
      callId: 'fail-first',
      result: 'late success',
    });

    expect(snapshot.edges.find(edge => edge.callId === 'complete-first')).toMatchObject({
      status: 'completed',
      completedAt: at(3),
      failedAt: null,
      result: 'done',
      error: null,
    });
    expect(snapshot.edges.find(edge => edge.callId === 'fail-first')).toMatchObject({
      status: 'failed',
      completedAt: null,
      failedAt: at(5),
      result: null,
      error: 'boom',
    });
  });

  it('keeps one stable node when the same agent session is resumed', async () => {
    const { store } = await createStore();
    await store.upsertEvent(rootStarted());
    await store.upsertEvent({
      type: 'thread.started',
      eventId: 'child-first',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'child-stable',
      sessionId: 'session-child',
      parentExecutionId: 'root-execution',
      agentName: 'Researcher',
    });
    await store.upsertEvent({
      type: 'turn.started',
      eventId: 'turn-one-start',
      rootExecutionId: 'root-execution',
      occurredAt: at(2),
      executionId: 'child-stable',
      sessionId: 'session-child',
      runId: 'run-1',
    });
    await store.upsertEvent({
      type: 'turn.completed',
      eventId: 'turn-one-end',
      rootExecutionId: 'root-execution',
      occurredAt: at(3),
      executionId: 'child-stable',
      sessionId: 'session-child',
      runId: 'run-1',
      result: 'First answer',
    });
    await store.upsertEvent({
      type: 'thread.started',
      eventId: 'child-resume',
      rootExecutionId: 'root-execution',
      occurredAt: at(4),
      executionId: 'transient-resume-id',
      sessionId: 'session-child',
      parentExecutionId: 'root-execution',
      agentName: 'Researcher',
      threadStatus: 'active',
    });
    const snapshot = await store.upsertEvent({
      type: 'turn.started',
      eventId: 'turn-two-start',
      rootExecutionId: 'root-execution',
      occurredAt: at(5),
      executionId: 'transient-resume-id',
      sessionId: 'session-child',
      runId: 'run-2',
    });

    const childNodes = snapshot.nodes.filter((node) => node.sessionId === 'session-child');
    expect(childNodes).toHaveLength(1);
    expect(childNodes[0]).toMatchObject({
      id: 'child-stable',
      runIds: ['run-1', 'run-2'],
      agentStatus: 'running',
      result: null,
    });
  });

  it('deduplicates eventId and publishes only committed root-scoped updates', async () => {
    const { store } = await createStore();
    const rootListener = vi.fn();
    const otherListener = vi.fn();
    const unsubscribe = store.subscribe('root-execution', rootListener);
    store.subscribe('other-root', otherListener);
    const event = rootStarted();

    const first = await store.upsertEvent(event);
    const replay = await store.upsertEvent(event);
    expect(replay.events).toHaveLength(1);
    expect(replay.updatedAt).toBe(first.updatedAt);
    expect(rootListener).toHaveBeenCalledTimes(1);
    expect(rootListener).toHaveBeenCalledWith({ event, snapshot: first });
    expect(otherListener).not.toHaveBeenCalled();

    unsubscribe();
    await store.upsertEvent({
      type: 'thread.status',
      eventId: 'after-unsubscribe',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'root-execution',
      agentStatus: 'running',
    });
    expect(rootListener).toHaveBeenCalledTimes(1);
  });

  it('reduces status, plan, activity, result, and error state', async () => {
    const { store } = await createStore();
    await store.upsertEvent(rootStarted());
    await store.upsertEvent({
      type: 'plan.updated',
      eventId: 'plan',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'root-execution',
      plan: [
        { id: 'inspect', title: 'Inspect', status: 'completed' },
        { id: 'implement', title: 'Implement', status: 'in_progress' },
        { id: 'verify', title: 'Verify', status: 'pending' },
      ],
    });
    await store.upsertEvent({
      type: 'activity',
      eventId: 'activity',
      rootExecutionId: 'root-execution',
      occurredAt: at(2),
      executionId: 'root-execution',
      activity: {
        kind: 'tool',
        summary: 'Running focused tests',
        toolName: 'npm test',
        startedAt: at(2),
      },
    });
    const errored = await store.upsertEvent({
      type: 'thread.status',
      eventId: 'status-error',
      rootExecutionId: 'root-execution',
      occurredAt: at(3),
      executionId: 'root-execution',
      agentStatus: 'errored',
      threadStatus: 'system_error',
      error: 'Provider disconnected',
    });
    expect(errored.nodes[0]).toMatchObject({
      agentStatus: 'errored',
      threadStatus: 'system_error',
      currentPlan: [
        expect.objectContaining({ id: 'inspect', status: 'completed' }),
        expect.objectContaining({ id: 'implement', status: 'in_progress' }),
        expect.objectContaining({ id: 'verify', status: 'pending' }),
      ],
      currentActivity: expect.objectContaining({
        kind: 'tool',
        summary: 'Running focused tests',
      }),
      error: 'Provider disconnected',
    });
    expect(errored.nodes[0]?.timestamps.completedAt).toBe(at(3));
    expect(errored.nodes[0]?.timestamps.lastActivityAt).toBe(at(2));
  });

  it('reloads persisted graphs after a store restart', async () => {
    const { store, root } = await createStore();
    await store.upsertEvent(rootStarted());
    await store.upsertEvent({
      type: 'turn.started',
      eventId: 'turn',
      rootExecutionId: 'root-execution',
      occurredAt: at(1),
      executionId: 'root-execution',
      runId: 'run-after-restart',
    });

    const restarted = new AgentExecutionStore(root);
    await expect(restarted.getSnapshot('root-execution')).resolves.toMatchObject({
      rootExecutionId: 'root-execution',
      nodes: [expect.objectContaining({ runIds: ['run-after-restart'] })],
      events: [expect.objectContaining({ eventId: 'event-root' }), expect.objectContaining({ eventId: 'turn' })],
    });
    await expect(restarted.listByRoot('root-execution')).resolves.toHaveLength(1);
    await expect(restarted.list()).resolves.toHaveLength(1);
    await expect(restarted.listSnapshots()).resolves.toHaveLength(1);
  });

  it('serializes writers from separate store instances without losing nodes', async () => {
    const { store, root } = await createStore();
    const second = new AgentExecutionStore(root);
    await store.upsertEvent(rootStarted());

    await Promise.all([
      store.upsertEvent({
        type: 'thread.started',
        eventId: 'writer-a',
        rootExecutionId: 'root-execution',
        occurredAt: at(1),
        executionId: 'child-a',
        sessionId: 'session-a',
        parentExecutionId: 'root-execution',
        agentName: 'Writer A',
      }),
      second.upsertEvent({
        type: 'thread.started',
        eventId: 'writer-b',
        rootExecutionId: 'root-execution',
        occurredAt: at(2),
        executionId: 'child-b',
        sessionId: 'session-b',
        parentExecutionId: 'root-execution',
        agentName: 'Writer B',
      }),
    ]);

    const snapshot = await store.getSnapshot('root-execution');
    expect(snapshot?.nodes.map(node => node.id).sort()).toEqual([
      'child-a',
      'child-b',
      'root-execution',
    ]);
  });

  it('loads legacy snapshots and isolates corrupt files', async () => {
    const { store, root } = await createStore();
    const directory = path.join(root, 'agent-executions');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'legacy-root.json'),
      JSON.stringify({
        rootExecutionId: 'legacy-root',
        createdAt: at(0),
        updatedAt: at(1),
        executions: [{ id: 'legacy-root', sessionId: 'legacy-session', agentName: 'Legacy' }],
      }),
      'utf8',
    );
    await writeFile(path.join(directory, 'corrupt.json'), '{not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const snapshots = await store.listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      version: 1,
      rootExecutionId: 'legacy-root',
      edges: [],
      events: [],
      nodes: [
        expect.objectContaining({
          id: 'legacy-root',
          canonicalPath: '/root',
          runtime: 'hadamard',
        }),
      ],
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt.json'));
    await expect(store.getSnapshot('corrupt')).rejects.toThrow();
  });

  it('rejects unsafe storage keys without escaping the session root', async () => {
    const { store, temp } = await createStore();
    const sentinel = path.join(temp, 'escaped.json');
    await writeFile(sentinel, '{"sentinel":true}\n', 'utf8');

    await expect(store.get('../../escaped')).rejects.toThrow('Unsafe executionId');
    await expect(store.getSnapshot('../../escaped')).rejects.toThrow('Unsafe rootExecutionId');
    expect(() => store.subscribe('../../escaped', () => undefined)).toThrow(
      'Unsafe rootExecutionId',
    );
    await expect(
      store.upsertEvent({ ...rootStarted(), rootExecutionId: '../../escaped' }),
    ).rejects.toThrow('Unsafe rootExecutionId');
    expect(await readFile(sentinel, 'utf8')).toContain('sentinel');
  });

  it('keeps only the most recent 1000 persisted lifecycle events', () => {
    let snapshot: AgentExecutionSnapshot | undefined;
    snapshot = reduceAgentExecutionEvent(snapshot, rootStarted());
    for (let index = 0; index < MAX_AGENT_EXECUTION_EVENT_HISTORY + 5; index += 1) {
      snapshot = reduceAgentExecutionEvent(snapshot, {
        type: 'activity',
        eventId: `activity-${index}`,
        rootExecutionId: 'root-execution',
        occurredAt: at(index + 1),
        executionId: 'root-execution',
        activity: {
          kind: 'thinking',
          summary: `Step ${index}`,
          startedAt: at(index + 1),
        },
      });
    }

    expect(snapshot.events).toHaveLength(MAX_AGENT_EXECUTION_EVENT_HISTORY);
    expect(snapshot.events[0]?.eventId).toBe('activity-5');
    expect(snapshot.events.at(-1)?.eventId).toBe('activity-1004');
    const replayed = reduceAgentExecutionEvent(snapshot, rootStarted());
    expect(replayed).toBe(snapshot);
    expect(replayed.seenEventIds).toContain('event-root');
  });
});
