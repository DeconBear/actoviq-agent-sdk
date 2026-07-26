import { describe, expect, it } from 'vitest';

import type {
  AgentExecutionEdge,
  AgentExecutionNode,
  AgentExecutionSnapshot,
  AgentExecutionStatus,
  AgentExecutionTimestamps,
} from '../src/runtime/agentExecution.js';
import {
  createAgentExecutionProjectView,
  createAgentExecutionRootView,
  formatAgentExecutionTreeLines,
} from '../src/ui/agentExecutionView.js';

function at(second: number): string {
  return new Date(Date.UTC(2026, 6, 16, 0, 0, second)).toISOString();
}

type NodePatch = Omit<Partial<AgentExecutionNode>, 'timestamps'> & {
  timestamps?: Partial<AgentExecutionTimestamps>;
};

function executionNode(
  id: string,
  status: AgentExecutionStatus,
  patch: NodePatch = {},
): AgentExecutionNode {
  const { timestamps, ...nodePatch } = patch;
  const rootExecutionId = patch.rootExecutionId ?? (id.startsWith('root') ? id : 'root');
  const defaults: AgentExecutionTimestamps = {
    createdAt: at(0),
    updatedAt: at(5),
    startedAt: at(1),
    turnStartedAt: null,
    turnCompletedAt: status === 'completed' ? at(4) : null,
    completedAt: status === 'completed' ? at(4) : null,
    interruptedAt: status === 'interrupted' ? at(4) : null,
    lastActivityAt: null,
  };
  return {
    id,
    sessionId: `session-${id}`,
    rootExecutionId,
    parentExecutionId: id === rootExecutionId ? null : rootExecutionId,
    parentSessionId: id === rootExecutionId ? null : `session-${rootExecutionId}`,
    canonicalPath: id === rootExecutionId ? '/root' : `/root/${id}`,
    spawnOrder: 0,
    agentName: id,
    nickname: null,
    role: null,
    kind: id === rootExecutionId ? 'root' : 'subagent',
    runtime: 'hadamard',
    model: 'test-model',
    cwd: 'C:/workspace',
    agentStatus: status,
    threadStatus: status === 'running' ? 'active' : 'idle',
    currentPlan: [],
    currentActivity: null,
    runIds: [],
    timestamps: { ...defaults, ...timestamps },
    error: null,
    result: null,
    ...nodePatch,
  };
}

function executionSnapshot(
  rootExecutionId: string,
  nodes: AgentExecutionNode[],
  updatedAt = at(10),
): AgentExecutionSnapshot {
  return {
    version: 1,
    rootExecutionId,
    nodes,
    edges: [],
    events: [{
      type: 'thread.status',
      eventId: `private-event-${rootExecutionId}`,
      rootExecutionId,
      occurredAt: updatedAt,
      executionId: rootExecutionId,
      agentStatus: 'running',
    }],
    seenEventIds: [`private-event-${rootExecutionId}`],
    createdAt: at(0),
    updatedAt,
  };
}

describe('agentExecutionView', () => {
  it('builds a stably ordered hierarchy and aggregates status and counts', () => {
    const root = executionNode('root', 'running', {
      nickname: 'Coordinator',
      currentActivity: {
        kind: 'delegating',
        summary: 'Waiting for reviews',
        startedAt: at(6),
      },
    });
    const laterChild = executionNode('builder', 'completed', {
      parentExecutionId: 'root',
      spawnOrder: 2,
      agentName: 'Builder',
      result: 'Implemented',
    });
    const earlierChild = executionNode('reviewer', 'errored', {
      parentExecutionId: 'root',
      spawnOrder: 1,
      agentName: 'Reviewer',
      error: 'Review failed',
      timestamps: {
        turnCompletedAt: at(7),
        completedAt: at(7),
        updatedAt: at(7),
      },
    });
    const view = createAgentExecutionRootView(
      executionSnapshot('root', [laterChild, root, earlierChild]),
      at(12),
    );

    expect(view).toMatchObject({
      rootExecutionId: 'root',
      rootSessionId: 'session-root',
      displayName: 'Coordinator',
      status: 'errored',
      isActive: true,
      nodeCount: 3,
      subagentCount: 2,
      activeNodeCount: 1,
      completedNodeCount: 1,
      erroredNodeCount: 1,
      currentActivity: { summary: 'Waiting for reviews' },
    });
    expect(view.root?.children.map((node) => node.id)).toEqual(['reviewer', 'builder']);
    expect(view.root?.children.map((node) => node.depth)).toEqual([1, 1]);
    expect(view).not.toHaveProperty('events');
    expect(view).not.toHaveProperty('seenEventIds');
    expect(JSON.stringify(view)).not.toContain('private-event-root');
  });

  it('derives display name, activity, current and next plan steps, error, and result', () => {
    const root = executionNode('root-plan', 'running', {
      nickname: '  Planner  ',
      role: 'Fallback role',
      agentName: 'Fallback agent',
      currentActivity: {
        kind: 'tool',
        summary: 'Reading the runtime',
        toolName: 'Read',
        startedAt: at(3),
        updatedAt: at(4),
      },
      currentPlan: [
        { id: 'done', title: 'Inspect', status: 'completed' },
        { id: 'current', title: 'Implement presenter', status: 'in_progress' },
        { id: 'next', title: 'Run tests', status: 'pending' },
        { id: 'blocked', title: 'Visual QA', status: 'blocked' },
      ],
      error: 'Non-fatal warning',
      result: 'Partial result',
      runIds: ['run-1', 'run-2'],
    });
    const child = executionNode('focused-child', 'running', {
      rootExecutionId: 'root-plan',
      parentExecutionId: 'root-plan',
      spawnOrder: 1,
      currentPlan: [
        { id: 'child-current', title: 'Review implementation', status: 'in_progress' },
        { id: 'child-next', title: 'Report findings', status: 'pending' },
      ],
      timestamps: {
        updatedAt: at(8),
        lastActivityAt: at(8),
      },
    });
    const view = createAgentExecutionRootView(
      executionSnapshot('root-plan', [root, child]),
      at(12),
    );

    expect(view.root).toMatchObject({
      sessionId: 'session-root-plan',
      displayName: 'Planner',
      status: 'running',
      isActive: true,
      currentActivity: {
        kind: 'tool',
        summary: 'Reading the runtime',
        toolName: 'Read',
      },
      currentStep: { id: 'current', title: 'Implement presenter' },
      error: 'Non-fatal warning',
      result: 'Partial result',
      runCount: 2,
    });
    expect(view.root?.nextSteps.map((step) => step.id)).toEqual(['next', 'blocked']);
    expect(view.root?.plan).not.toBe(root.currentPlan);
    expect(view.root?.currentActivity).not.toBe(root.currentActivity);
    expect(view).toMatchObject({
      subagentCount: 1,
      focusedExecutionId: 'focused-child',
      currentStep: { id: 'child-current', title: 'Review implementation' },
    });
    expect(view.nextSteps.map((step) => step.id)).toEqual(['child-next']);

    const fallbackChild = executionNode('focused-without-plan', 'running', {
      rootExecutionId: 'root-plan',
      parentExecutionId: 'root-plan',
      timestamps: {
        updatedAt: at(9),
        lastActivityAt: at(9),
      },
    });
    const fallback = createAgentExecutionRootView(
      executionSnapshot('root-plan', [root, fallbackChild]),
      at(12),
    );
    expect(fallback.focusedExecutionId).toBe('focused-without-plan');
    expect(fallback.currentStep?.id).toBe('current');
    expect(fallback.nextSteps.map((step) => step.id)).toEqual(['next', 'blocked']);
  });

  it('computes deterministic active and terminal timing from the supplied clock', () => {
    const root = executionNode('root-time', 'running', {
      timestamps: {
        createdAt: at(0),
        startedAt: at(1),
        turnStartedAt: at(2),
        updatedAt: at(8),
      },
    });
    const child = executionNode('timed-child', 'completed', {
      rootExecutionId: 'root-time',
      parentExecutionId: 'root-time',
      timestamps: {
        createdAt: at(3),
        startedAt: at(3),
        turnStartedAt: at(4),
        turnCompletedAt: at(9),
        completedAt: at(9),
        updatedAt: at(9),
      },
    });
    const view = createAgentExecutionRootView(
      executionSnapshot('root-time', [root, child], at(9)),
      at(12),
    );

    expect(view.root?.timing).toEqual({
      createdAt: at(0),
      updatedAt: at(8),
      startedAt: at(2),
      completedAt: null,
      elapsedMs: 10_000,
      durationMs: null,
    });
    expect(view.root?.children[0]?.timing).toEqual({
      createdAt: at(3),
      updatedAt: at(9),
      startedAt: at(4),
      completedAt: at(9),
      elapsedMs: 5_000,
      durationMs: 5_000,
    });
    expect(view.timing).toMatchObject({
      createdAt: at(0),
      startedAt: at(2),
      completedAt: null,
      elapsedMs: 10_000,
      durationMs: null,
    });
  });

  it('groups running, waiting, and terminal executions deterministically', () => {
    const activeB = executionSnapshot(
      'root-b',
      [executionNode('root-b', 'running')],
      at(20),
    );
    const activeA = executionSnapshot(
      'root-a',
      [executionNode('root-a', 'pending_init')],
      at(20),
    );
    const waiting = executionSnapshot(
      'root-old',
      [executionNode('root-old', 'interrupted')],
      at(12),
    );
    const completedOld = executionSnapshot(
      'root-finished',
      [executionNode('root-finished', 'completed')],
      at(11),
    );
    const completedNew = executionSnapshot(
      'root-new',
      [executionNode('root-new', 'errored', { error: 'boom' })],
      at(18),
    );
    const view = createAgentExecutionProjectView(
      [waiting, activeB, completedNew, completedOld, activeA],
      at(30),
    );

    expect(view.active.map((execution) => execution.rootExecutionId)).toEqual([
      'root-a',
      'root-b',
    ]);
    expect(view.waiting.map((execution) => execution.rootExecutionId)).toEqual(['root-old']);
    expect(view.completed.map((execution) => execution.rootExecutionId)).toEqual([
      'root-new',
      'root-finished',
    ]);
    expect(view.waiting[0]).toMatchObject({
      lifecycle: 'waiting',
      isActive: false,
      isWaiting: true,
      waitingNodeCount: 1,
    });
    expect(view).toMatchObject({
      totalExecutionCount: 5,
      totalAgentCount: 5,
      activeExecutionCount: 2,
      waitingExecutionCount: 1,
      completedExecutionCount: 2,
      erroredExecutionCount: 1,
      updatedAt: at(20),
    });
    expect(view).not.toHaveProperty('events');
    expect(view).not.toHaveProperty('seenEventIds');
  });

  it('exposes delegate, message, and resume relationships as stable UI-safe copies', () => {
    const root = executionNode('root-edges', 'running');
    const child = executionNode('edge-child', 'completed', {
      rootExecutionId: 'root-edges',
      parentExecutionId: 'root-edges',
    });
    const edges: AgentExecutionEdge[] = [
      {
        callId: 'call-delegate',
        kind: 'delegate',
        status: 'completed',
        sourceExecutionId: 'root-edges',
        targetExecutionId: 'edge-child',
        sourceSessionId: 'session-root-edges',
        targetSessionId: 'session-edge-child',
        summary: 'Delegate implementation',
        startedAt: at(4),
        completedAt: at(5),
        failedAt: null,
        error: null,
        result: 'implemented',
      },
      {
        callId: 'call-message',
        kind: 'message',
        status: 'started',
        sourceExecutionId: 'edge-child',
        targetExecutionId: 'root-edges',
        sourceSessionId: 'session-edge-child',
        targetSessionId: 'session-root-edges',
        summary: 'Ask for clarification',
        startedAt: at(2),
        completedAt: null,
        failedAt: null,
        error: null,
        result: null,
      },
      {
        callId: 'call-resume',
        kind: 'resume',
        status: 'failed',
        sourceExecutionId: 'root-edges',
        targetExecutionId: 'edge-child',
        sourceSessionId: 'session-root-edges',
        targetSessionId: 'session-edge-child',
        summary: 'Resume reviewer',
        startedAt: at(4),
        completedAt: null,
        failedAt: at(6),
        error: 'session unavailable',
        result: null,
      },
    ];
    const snapshot = executionSnapshot('root-edges', [root, child], at(6));
    snapshot.edges = edges;
    const view = createAgentExecutionRootView(snapshot, at(8));

    expect(view.edgeCount).toBe(3);
    expect(view.edges.map((edge) => edge.kind)).toEqual([
      'message',
      'delegate',
      'resume',
    ]);
    expect(view.edges).toEqual([
      expect.objectContaining({
        callId: 'call-message',
        sourceSessionId: 'session-edge-child',
        targetSessionId: 'session-root-edges',
      }),
      expect.objectContaining({
        callId: 'call-delegate',
        status: 'completed',
        result: 'implemented',
      }),
      expect.objectContaining({
        callId: 'call-resume',
        status: 'failed',
        error: 'session unavailable',
      }),
    ]);
    expect(view.edges[0]).not.toBe(edges[1]);
    expect(view).not.toHaveProperty('events');
    expect(view).not.toHaveProperty('seenEventIds');
  });

  it('keeps detached descendants nested and formats activity, plans, timing, and errors', () => {
    const root = executionNode('root-tree', 'completed', {
      agentName: 'Main',
    });
    const orphan = executionNode('orphan', 'interrupted', {
      rootExecutionId: 'root-tree',
      parentExecutionId: 'missing-parent',
      agentName: 'Orphan',
      currentActivity: {
        kind: 'waiting',
        summary: 'Waiting for input',
        startedAt: at(3),
      },
      currentPlan: [
        { id: 'current', title: 'Investigate', status: 'in_progress' },
        { id: 'next', title: 'Retry', status: 'pending' },
      ],
      timestamps: {
        interruptedAt: at(6),
        updatedAt: at(6),
      },
    });
    const orphanChild = executionNode('orphan-child', 'errored', {
      rootExecutionId: 'root-tree',
      parentExecutionId: 'orphan',
      agentName: 'Orphan child',
      error: 'child failed',
      timestamps: {
        turnCompletedAt: at(7),
        completedAt: at(7),
        updatedAt: at(7),
      },
    });
    const view = createAgentExecutionRootView(
      executionSnapshot('root-tree', [orphanChild, orphan, root], at(7)),
      at(10),
    );
    const lines = formatAgentExecutionTreeLines(view);

    expect(view.detached).toHaveLength(1);
    expect(view.detached[0]?.id).toBe('orphan');
    expect(view.detached[0]?.children.map((node) => node.id)).toEqual(['orphan-child']);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringContaining('[x] Main [completed]'),
      'Detached',
      expect.stringContaining('[~] Orphan [interrupted]'),
      expect.stringContaining('[!] Orphan child [errored]'),
    ]));
    expect(lines.find((line) => line.includes('Orphan'))).toContain('Waiting for input');
    expect(lines.find((line) => line.includes('Orphan'))).toContain('step: Investigate');
    expect(lines.find((line) => line.includes('Orphan'))).toContain('next: Retry');
    expect(lines.find((line) => line.includes('Orphan child'))).toContain(
      'error: child failed',
    );
    expect(lines.find((line) => line.includes('Orphan child'))).toContain('duration: 6s');
  });
});
