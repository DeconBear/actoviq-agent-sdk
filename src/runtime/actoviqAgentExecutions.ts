import type {
  AgentEvent,
  AgentRunResult,
  StoredSession,
} from '../types.js';
import {
  createAgentExecutionTree,
  type AgentExecutionActivity,
  type AgentExecutionEdgeKind,
  type AgentExecutionEvent,
  type AgentExecutionNode,
  type AgentExecutionPlanStep,
  type AgentExecutionSnapshot,
  type AgentExecutionTreeSnapshot,
} from './agentExecution.js';
import {
  AgentExecutionStore,
  type AgentExecutionStoreListener,
} from '../storage/agentExecutionStore.js';
import { createId, nowIso } from './helpers.js';

export const ACTOVIQ_EXECUTION_ID_KEY = '__actoviqExecutionId';
export const ACTOVIQ_ROOT_EXECUTION_ID_KEY = '__actoviqRootExecutionId';
export const ACTOVIQ_PARENT_EXECUTION_ID_KEY = '__actoviqParentExecutionId';
export const ACTOVIQ_AGENT_PATH_KEY = '__actoviqAgentPath';
const EXECUTION_DELTA_PERSIST_INTERVAL_MS = 1_000;

export interface AgentExecutionIdentity {
  executionId: string;
  sessionId: string;
  rootExecutionId: string;
  parentExecutionId: string | null;
  parentSessionId: string | null;
  canonicalPath: string;
  agentName: string;
  nickname: string | null;
  role: string | null;
  kind: 'root' | 'subagent';
  runtime: string;
  model: string | null;
  cwd: string;
}

export interface ResolveAgentExecutionIdentityOptions {
  runId: string;
  session?: Pick<StoredSession, 'id' | 'kind' | 'parentSessionId' | 'metadata'>;
  metadata?: Record<string, unknown>;
  model?: string;
  cwd: string;
  runtime?: string;
}

export interface CreateChildAgentExecutionIdentityOptions {
  sessionId: string;
  parent: AgentExecutionIdentity;
  agentName: string;
  nickname?: string;
  role?: string;
  model?: string;
  cwd: string;
}

export interface AgentExecutionEdgeInput {
  callId: string;
  kind: AgentExecutionEdgeKind;
  source: AgentExecutionIdentity;
  target: AgentExecutionIdentity;
  summary?: string;
}

export interface SettleAgentExecutionOptions {
  outcome: 'completed' | 'interrupted' | 'errored';
  result?: AgentRunResult;
  error?: string;
}

function metadataString(
  primary: Record<string, unknown> | undefined,
  secondary: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const primaryValue = primary?.[key];
  if (typeof primaryValue === 'string' && primaryValue.trim()) {
    return primaryValue.trim();
  }
  const secondaryValue = secondary?.[key];
  return typeof secondaryValue === 'string' && secondaryValue.trim()
    ? secondaryValue.trim()
    : undefined;
}

function pathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'agent';
}

export function resolveAgentExecutionIdentity(
  options: ResolveAgentExecutionIdentityOptions,
): AgentExecutionIdentity {
  // Persisted session identity wins over inherited per-run metadata. This is
  // essential when a child inherits its parent's run options.
  const sessionMetadata = options.session?.metadata;
  const runMetadata = options.metadata;
  const sessionId = options.session?.id ?? options.runId;
  const executionId =
    metadataString(sessionMetadata, runMetadata, ACTOVIQ_EXECUTION_ID_KEY) ?? sessionId;
  const parentExecutionId =
    metadataString(sessionMetadata, runMetadata, ACTOVIQ_PARENT_EXECUTION_ID_KEY) ?? null;
  const rootExecutionId =
    metadataString(sessionMetadata, runMetadata, ACTOVIQ_ROOT_EXECUTION_ID_KEY) ??
    (parentExecutionId ? parentExecutionId : executionId);
  const parentSessionId = options.session?.parentSessionId ??
    metadataString(sessionMetadata, runMetadata, '__actoviqParentSessionId') ?? null;
  const agentName =
    metadataString(sessionMetadata, runMetadata, '__actoviqAgentDefinition') ??
    metadataString(sessionMetadata, runMetadata, '__actoviqAgentName') ??
    'Hadamard';
  const nickname =
    metadataString(sessionMetadata, runMetadata, '__actoviqAgentName') ?? null;
  const parentPath = parentExecutionId ? '/root' : '';
  const canonicalPath =
    metadataString(sessionMetadata, runMetadata, ACTOVIQ_AGENT_PATH_KEY) ??
    (parentExecutionId
      ? `${parentPath}/${pathSegment(nickname ?? agentName)}-${executionId.slice(0, 8)}`
      : '/root');

  return {
    executionId,
    sessionId,
    rootExecutionId,
    parentExecutionId,
    parentSessionId,
    canonicalPath,
    agentName,
    nickname,
    role: metadataString(sessionMetadata, runMetadata, '__actoviqAgentRole') ?? null,
    kind: parentExecutionId ? 'subagent' : 'root',
    runtime: metadataString(sessionMetadata, runMetadata, '__actoviqRuntime')
      ?? options.runtime
      ?? 'hadamard',
    model: options.model ?? null,
    cwd: options.cwd,
  };
}

export function createChildAgentExecutionIdentity(
  options: CreateChildAgentExecutionIdentityOptions,
): AgentExecutionIdentity {
  const label = options.nickname ?? options.agentName;
  const parentPath = options.parent.canonicalPath || '/root';
  return {
    executionId: options.sessionId,
    sessionId: options.sessionId,
    rootExecutionId: options.parent.rootExecutionId,
    parentExecutionId: options.parent.executionId,
    parentSessionId: options.parent.sessionId,
    canonicalPath: `${parentPath}/${pathSegment(label)}-${options.sessionId.slice(0, 8)}`,
    agentName: options.agentName,
    nickname: options.nickname ?? null,
    role: options.role ?? null,
    kind: 'subagent',
    runtime: 'hadamard',
    model: options.model ?? null,
    cwd: options.cwd,
  };
}

export function serializeAgentExecutionIdentity(
  identity: AgentExecutionIdentity,
): Record<string, unknown> {
  return {
    [ACTOVIQ_EXECUTION_ID_KEY]: identity.executionId,
    [ACTOVIQ_ROOT_EXECUTION_ID_KEY]: identity.rootExecutionId,
    ...(identity.parentExecutionId
      ? { [ACTOVIQ_PARENT_EXECUTION_ID_KEY]: identity.parentExecutionId }
      : {}),
    ...(identity.parentSessionId
      ? { __actoviqParentSessionId: identity.parentSessionId }
      : {}),
    [ACTOVIQ_AGENT_PATH_KEY]: identity.canonicalPath,
    __actoviqAgentName: identity.nickname ?? identity.agentName,
    ...(identity.role ? { __actoviqAgentRole: identity.role } : {}),
  };
}

function todoPlan(executionId: string, value: unknown): AgentExecutionPlanStep[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { newTodos?: unknown; todos?: unknown };
  const todos = Array.isArray(record.newTodos)
    ? record.newTodos
    : Array.isArray(record.todos)
      ? record.todos
      : undefined;
  if (!todos) return undefined;
  return todos.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as { content?: unknown; subject?: unknown; status?: unknown; activeForm?: unknown };
    const title = typeof item.content === 'string'
      ? item.content.trim()
      : typeof item.subject === 'string'
        ? item.subject.trim()
        : '';
    if (!title) return [];
    const status = item.status === 'in_progress'
      ? 'in_progress'
      : item.status === 'completed'
        ? 'completed'
        : item.status === 'blocked'
          ? 'blocked'
          : 'pending';
    return [{
      id: `${executionId}:step:${index}:${pathSegment(title).slice(0, 32)}`,
      title,
      status,
      ...(typeof item.activeForm === 'string' && item.activeForm.trim()
        ? { description: item.activeForm.trim() }
        : {}),
    } satisfies AgentExecutionPlanStep];
  });
}

function textActivity(_summary: string, timestamp: string): AgentExecutionActivity {
  return {
    kind: 'message',
    summary: 'Writing response',
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Public read/subscribe API plus the runtime-owned event projector. The
 * transcript remains in SessionStore; this API stores only UI-safe summaries.
 */
export class ActoviqAgentExecutionsApi {
  private readonly pendingByRoot = new Map<string, Set<Promise<unknown>>>();
  private readonly activityCounters = new Map<string, number>();
  private readonly lastDeltaAt = new Map<string, number>();

  constructor(private readonly store: AgentExecutionStore) {}

  list(): Promise<AgentExecutionNode[]> {
    return this.store.list();
  }

  listSnapshots(): Promise<AgentExecutionSnapshot[]> {
    return this.store.listSnapshots();
  }

  get(executionId: string): Promise<AgentExecutionNode | undefined> {
    return this.store.get(executionId);
  }

  getSnapshot(rootExecutionId: string): Promise<AgentExecutionSnapshot | undefined> {
    return this.store.getSnapshot(rootExecutionId);
  }

  async getTree(rootExecutionId: string): Promise<AgentExecutionTreeSnapshot | undefined> {
    const snapshot = await this.store.getSnapshot(rootExecutionId);
    return snapshot ? createAgentExecutionTree(snapshot) : undefined;
  }

  subscribe(rootExecutionId: string, listener: AgentExecutionStoreListener): () => void {
    return this.store.subscribe(rootExecutionId, ({ event, snapshot }) => {
      // Live consumers need the current graph, not the entire replay log on
      // every delta. Full history remains available through getSnapshot().
      listener({
        event,
        snapshot: {
          ...snapshot,
          events: [],
          seenEventIds: [],
        },
      });
    });
  }

  async ensureThread(identity: AgentExecutionIdentity): Promise<AgentExecutionSnapshot> {
    return this.record({
      type: 'thread.started',
      eventId: `thread:${identity.executionId}:started`,
      rootExecutionId: identity.rootExecutionId,
      occurredAt: nowIso(),
      executionId: identity.executionId,
      sessionId: identity.sessionId,
      parentExecutionId: identity.parentExecutionId,
      parentSessionId: identity.parentSessionId,
      canonicalPath: identity.canonicalPath,
      agentName: identity.agentName,
      nickname: identity.nickname,
      role: identity.role,
      kind: identity.kind,
      runtime: identity.runtime,
      model: identity.model,
      cwd: identity.cwd,
      agentStatus: 'pending_init',
      threadStatus: 'active',
    });
  }

  async startTurn(identity: AgentExecutionIdentity, runId: string): Promise<AgentExecutionSnapshot> {
    await this.ensureThread(identity);
    return this.record({
      type: 'turn.started',
      eventId: `turn:${runId}:started`,
      rootExecutionId: identity.rootExecutionId,
      occurredAt: nowIso(),
      executionId: identity.executionId,
      sessionId: identity.sessionId,
      runId,
    });
  }

  recordRuntimeEvent(identity: AgentExecutionIdentity, event: AgentEvent): void {
    const timestamp = event.timestamp || nowIso();
    let activity: AgentExecutionActivity | undefined;
    let plan: AgentExecutionPlanStep[] | undefined;

    switch (event.type) {
      case 'request.started':
        activity = {
          kind: 'thinking',
          summary: `Preparing model request ${event.iteration}`,
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        break;
      case 'response.thinking.delta':
        activity = {
          kind: 'thinking',
          summary: 'Reasoning',
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        break;
      case 'response.text.delta':
        activity = textActivity(event.snapshot || event.delta, timestamp);
        break;
      case 'response.content':
        if (event.content.type === 'text' && typeof event.content.text === 'string') {
          activity = textActivity(event.content.text, timestamp);
        }
        break;
      case 'tool.call':
        activity = {
          kind: event.call.publicName === 'Agent' || event.call.publicName === 'Task'
            ? 'delegating'
            : 'tool',
          summary: `${event.call.publicName === 'Agent' || event.call.publicName === 'Task'
            ? 'Delegating with'
            : 'Running'} ${event.call.publicName}`,
          toolName: event.call.publicName,
          startedAt: event.call.startedAt,
          updatedAt: timestamp,
        };
        break;
      case 'tool.result':
        if (event.result.publicName === 'TodoWrite' && !event.result.isError) {
          plan = todoPlan(identity.executionId, event.result.output);
        }
        activity = {
          kind: 'tool',
          summary: `${event.result.publicName} ${event.result.isError ? 'failed' : 'completed'}`,
          toolName: event.result.publicName,
          startedAt: event.result.startedAt,
          updatedAt: timestamp,
        };
        break;
      case 'request.interrupted':
        activity = {
          kind: 'waiting',
          summary: event.reason || 'Request interrupted',
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        break;
      case 'session.compacted':
      case 'conversation.compacted':
        activity = {
          kind: 'tool',
          summary: 'Compacting conversation context',
          toolName: 'Compact',
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        break;
      default:
        break;
    }

    if (plan) {
      void this.track(this.store.upsertEvent({
        type: 'plan.updated',
        eventId: `plan:${event.runId}:${event.type === 'tool.result' ? event.result.id : createId()}`,
        rootExecutionId: identity.rootExecutionId,
        occurredAt: timestamp,
        executionId: identity.executionId,
        sessionId: identity.sessionId,
        plan,
      }), identity.rootExecutionId).catch(error => {
        console.warn(`[AgentExecution] Failed to persist plan: ${(error as Error).message}`);
      });
    }
    if (!activity || !activity.summary) return;

    const highFrequency = event.type === 'response.text.delta' || event.type === 'response.thinking.delta';
    const eventTime = Date.parse(timestamp) || Date.now();
    const last = this.lastDeltaAt.get(identity.executionId) ?? 0;
    if (highFrequency && eventTime - last < EXECUTION_DELTA_PERSIST_INTERVAL_MS) return;
    if (highFrequency) this.lastDeltaAt.set(identity.executionId, eventTime);
    const counter = (this.activityCounters.get(identity.executionId) ?? 0) + 1;
    this.activityCounters.set(identity.executionId, counter);
    void this.track(this.store.upsertEvent({
      type: 'activity',
      eventId: `activity:${event.runId}:${counter}`,
      rootExecutionId: identity.rootExecutionId,
      occurredAt: timestamp,
      executionId: identity.executionId,
      sessionId: identity.sessionId,
      activity,
    }), identity.rootExecutionId).catch(error => {
      console.warn(`[AgentExecution] Failed to persist activity: ${(error as Error).message}`);
    });
  }

  async settleTurn(
    identity: AgentExecutionIdentity,
    runId: string,
    options: SettleAgentExecutionOptions,
  ): Promise<AgentExecutionSnapshot> {
    await this.flush(identity.rootExecutionId);
    const summary = options.result ? 'Completed successfully.' : undefined;
    return this.record({
      type: 'turn.completed',
      eventId: `turn:${runId}:${options.outcome}`,
      rootExecutionId: identity.rootExecutionId,
      occurredAt: options.result?.completedAt ?? nowIso(),
      executionId: identity.executionId,
      sessionId: identity.sessionId,
      runId,
      outcome: options.outcome,
      result: summary,
      error: options.error,
    });
  }

  async startEdge(input: AgentExecutionEdgeInput): Promise<AgentExecutionSnapshot> {
    await Promise.all([this.ensureThread(input.source), this.ensureThread(input.target)]);
    return this.record({
      type: 'edge.started',
      eventId: `edge:${input.callId}:started`,
      rootExecutionId: input.source.rootExecutionId,
      occurredAt: nowIso(),
      callId: input.callId,
      kind: input.kind,
      sourceExecutionId: input.source.executionId,
      targetExecutionId: input.target.executionId,
      sourceSessionId: input.source.sessionId,
      targetSessionId: input.target.sessionId,
      summary: input.summary,
    });
  }

  completeEdge(input: AgentExecutionEdgeInput, result?: string): Promise<AgentExecutionSnapshot> {
    return this.record({
      type: 'edge.completed',
      eventId: `edge:${input.callId}:completed`,
      rootExecutionId: input.source.rootExecutionId,
      occurredAt: nowIso(),
      callId: input.callId,
      kind: input.kind,
      sourceExecutionId: input.source.executionId,
      targetExecutionId: input.target.executionId,
      sourceSessionId: input.source.sessionId,
      targetSessionId: input.target.sessionId,
      summary: input.summary,
      result: result ? 'Completed successfully.' : undefined,
    });
  }

  failEdge(input: AgentExecutionEdgeInput, error: string): Promise<AgentExecutionSnapshot> {
    return this.record({
      type: 'edge.failed',
      eventId: `edge:${input.callId}:failed`,
      rootExecutionId: input.source.rootExecutionId,
      occurredAt: nowIso(),
      callId: input.callId,
      kind: input.kind,
      sourceExecutionId: input.source.executionId,
      targetExecutionId: input.target.executionId,
      sourceSessionId: input.source.sessionId,
      targetSessionId: input.target.sessionId,
      summary: input.summary,
      error,
    });
  }

  async completeEdgeByCallId(
    rootExecutionId: string,
    callId: string,
    result?: string,
  ): Promise<AgentExecutionSnapshot | undefined> {
    const snapshot = await this.store.getSnapshot(rootExecutionId);
    const edge = snapshot?.edges.find(candidate => candidate.callId === callId);
    if (!edge) return snapshot;
    return this.record({
      type: 'edge.completed',
      eventId: `edge:${callId}:completed`,
      rootExecutionId,
      occurredAt: nowIso(),
      callId,
      kind: edge.kind,
      sourceExecutionId: edge.sourceExecutionId,
      targetExecutionId: edge.targetExecutionId,
      sourceSessionId: edge.sourceSessionId,
      targetSessionId: edge.targetSessionId,
      summary: edge.summary,
      result: result ? 'Completed successfully.' : undefined,
    });
  }

  async failEdgeByCallId(
    rootExecutionId: string,
    callId: string,
    error: string,
  ): Promise<AgentExecutionSnapshot | undefined> {
    const snapshot = await this.store.getSnapshot(rootExecutionId);
    const edge = snapshot?.edges.find(candidate => candidate.callId === callId);
    if (!edge) return snapshot;
    return this.record({
      type: 'edge.failed',
      eventId: `edge:${callId}:failed`,
      rootExecutionId,
      occurredAt: nowIso(),
      callId,
      kind: edge.kind,
      sourceExecutionId: edge.sourceExecutionId,
      targetExecutionId: edge.targetExecutionId,
      sourceSessionId: edge.sourceSessionId,
      targetSessionId: edge.targetSessionId,
      summary: edge.summary,
      error,
    });
  }

  async failOpenEdgesForExecution(
    rootExecutionId: string,
    executionId: string,
    error: string,
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(rootExecutionId);
    if (!snapshot) return;
    const openEdges = snapshot.edges.filter(edge =>
      edge.status === 'started' && edge.targetExecutionId === executionId,
    );
    await Promise.all(openEdges.map(edge => this.record({
      type: 'edge.failed',
      eventId: `edge:${edge.callId}:failed`,
      rootExecutionId,
      occurredAt: nowIso(),
      callId: edge.callId,
      kind: edge.kind,
      sourceExecutionId: edge.sourceExecutionId,
      targetExecutionId: edge.targetExecutionId,
      sourceSessionId: edge.sourceSessionId,
      targetSessionId: edge.targetSessionId,
      summary: edge.summary,
      error,
    })));
  }

  async flush(rootExecutionId: string): Promise<void> {
    while (true) {
      const pending = [...(this.pendingByRoot.get(rootExecutionId) ?? [])];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private record(event: AgentExecutionEvent): Promise<AgentExecutionSnapshot> {
    return this.track(this.store.upsertEvent(event), event.rootExecutionId);
  }

  private track<T>(promise: Promise<T>, rootExecutionId: string): Promise<T> {
    const pending = this.pendingByRoot.get(rootExecutionId) ?? new Set<Promise<unknown>>();
    pending.add(promise);
    this.pendingByRoot.set(rootExecutionId, pending);
    void promise.finally(() => {
      pending.delete(promise);
      if (pending.size === 0) this.pendingByRoot.delete(rootExecutionId);
    }).catch(() => undefined);
    return promise;
  }
}
