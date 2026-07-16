import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';

import {
  MAX_AGENT_EXECUTION_EVENT_HISTORY,
  MAX_AGENT_EXECUTION_SEEN_EVENT_IDS,
  reduceAgentExecutionEvent,
  type AgentExecutionActivity,
  type AgentExecutionEdge,
  type AgentExecutionEdgeKind,
  type AgentExecutionEdgeStatus,
  type AgentExecutionEvent,
  type AgentExecutionEventDraft,
  type AgentExecutionKind,
  type AgentExecutionNode,
  type AgentExecutionPlanStep,
  type AgentExecutionPlanStepStatus,
  type AgentExecutionSnapshot,
  type AgentExecutionStatus,
  type AgentThreadStatus,
} from '../runtime/agentExecution.js';
import { createId, isRecord, nowIso } from '../runtime/helpers.js';
import { writeJsonAtomic } from './atomicJsonWrite.js';
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from './pathSafety.js';

const AGENT_STATUSES = new Set<AgentExecutionStatus>([
  'pending_init',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'not_found',
]);
const THREAD_STATUSES = new Set<AgentThreadStatus>([
  'not_loaded',
  'idle',
  'active',
  'system_error',
]);
const PLAN_STATUSES = new Set<AgentExecutionPlanStepStatus>([
  'pending',
  'in_progress',
  'completed',
  'blocked',
]);
const EDGE_KINDS = new Set<AgentExecutionEdgeKind>([
  'delegate',
  'message',
  'resume',
  'handoff',
]);
const EDGE_STATUSES = new Set<AgentExecutionEdgeStatus>(['started', 'completed', 'failed']);
const EVENT_TYPES = new Set<AgentExecutionEvent['type']>([
  'thread.started',
  'thread.status',
  'turn.started',
  'turn.completed',
  'plan.updated',
  'activity',
  'edge.started',
  'edge.completed',
  'edge.failed',
]);
const EXECUTION_LOCK_TIMEOUT_MS = 5_000;
const EXECUTION_LOCK_STALE_MS = 30_000;
const EXECUTION_LOCK_RETRY_MS = 10;

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export interface AgentExecutionStoreUpdate {
  event: AgentExecutionEvent;
  snapshot: AgentExecutionSnapshot;
}

export type AgentExecutionStoreListener = (update: AgentExecutionStoreUpdate) => void;

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

function normalizePlan(value: unknown): AgentExecutionPlanStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
      return [];
    }
    return [{
      id: entry.id,
      title: entry.title,
      status: enumValue(entry.status, PLAN_STATUSES, 'pending'),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    }];
  });
}

function normalizeActivity(value: unknown): AgentExecutionActivity | null {
  if (!isRecord(value) || typeof value.summary !== 'string') {
    return null;
  }
  const allowedKinds = new Set<AgentExecutionActivity['kind']>([
    'thinking',
    'tool',
    'message',
    'delegating',
    'waiting',
    'idle',
  ]);
  return {
    kind: enumValue(value.kind, allowedKinds, 'thinking'),
    summary: value.summary,
    startedAt: stringValue(value.startedAt, nowIso()),
    ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

function normalizeNode(
  value: unknown,
  rootExecutionId: string,
  snapshotCreatedAt: string,
  snapshotUpdatedAt: string,
): AgentExecutionNode | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string') {
    return undefined;
  }
  const timestamps = isRecord(value.timestamps) ? value.timestamps : {};
  const createdAt = stringValue(timestamps.createdAt, snapshotCreatedAt);
  const updatedAt = stringValue(timestamps.updatedAt, snapshotUpdatedAt);
  const parentExecutionId = nullableString(value.parentExecutionId);
  const kind = enumValue(
    value.kind,
    new Set<AgentExecutionKind>(['root', 'subagent']),
    parentExecutionId ? 'subagent' : 'root',
  );
  return {
    id: value.id,
    sessionId: value.sessionId,
    rootExecutionId: stringValue(value.rootExecutionId, rootExecutionId),
    parentExecutionId,
    parentSessionId: nullableString(value.parentSessionId),
    canonicalPath: stringValue(value.canonicalPath, kind === 'root' ? '/root' : ''),
    spawnOrder:
      typeof value.spawnOrder === 'number' && Number.isFinite(value.spawnOrder)
        ? value.spawnOrder
        : 0,
    agentName: stringValue(value.agentName, value.id),
    nickname: nullableString(value.nickname),
    role: nullableString(value.role),
    kind,
    runtime: stringValue(value.runtime, 'hadamard'),
    model: nullableString(value.model),
    cwd: stringValue(value.cwd),
    agentStatus: enumValue(value.agentStatus, AGENT_STATUSES, 'pending_init'),
    threadStatus: enumValue(value.threadStatus, THREAD_STATUSES, 'not_loaded'),
    currentPlan: normalizePlan(value.currentPlan),
    currentActivity: normalizeActivity(value.currentActivity),
    runIds: Array.isArray(value.runIds)
      ? [...new Set(value.runIds.filter((entry): entry is string => typeof entry === 'string'))]
      : [],
    timestamps: {
      createdAt,
      updatedAt,
      startedAt: nullableString(timestamps.startedAt),
      turnStartedAt: nullableString(timestamps.turnStartedAt),
      turnCompletedAt: nullableString(timestamps.turnCompletedAt),
      completedAt: nullableString(timestamps.completedAt),
      interruptedAt: nullableString(timestamps.interruptedAt),
      lastActivityAt: nullableString(timestamps.lastActivityAt),
    },
    error: nullableString(value.error),
    result: nullableString(value.result),
  };
}

function normalizeEdge(value: unknown): AgentExecutionEdge | undefined {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    typeof value.sourceExecutionId !== 'string' ||
    typeof value.targetExecutionId !== 'string'
  ) {
    return undefined;
  }
  return {
    callId: value.callId,
    kind: enumValue(value.kind, EDGE_KINDS, 'delegate'),
    status: enumValue(value.status, EDGE_STATUSES, 'started'),
    sourceExecutionId: value.sourceExecutionId,
    targetExecutionId: value.targetExecutionId,
    sourceSessionId: nullableString(value.sourceSessionId),
    targetSessionId: nullableString(value.targetSessionId),
    summary: nullableString(value.summary),
    startedAt: stringValue(value.startedAt, nowIso()),
    completedAt: nullableString(value.completedAt),
    failedAt: nullableString(value.failedAt),
    result: nullableString(value.result),
    error: nullableString(value.error),
  };
}

function normalizeEvent(value: unknown): AgentExecutionEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.eventId !== 'string' ||
    typeof value.rootExecutionId !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    typeof value.type !== 'string' ||
    !EVENT_TYPES.has(value.type as AgentExecutionEvent['type'])
  ) {
    return undefined;
  }
  return value as unknown as AgentExecutionEvent;
}

function parseSnapshot(raw: string, fallbackRootExecutionId: string): AgentExecutionSnapshot {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error('Agent execution snapshot must be a JSON object.');
  }
  const rootExecutionId = stringValue(value.rootExecutionId, fallbackRootExecutionId);
  if (rootExecutionId !== fallbackRootExecutionId) {
    throw new Error(
      `Agent execution snapshot root ${rootExecutionId} does not match ${fallbackRootExecutionId}.`,
    );
  }
  const createdAt = stringValue(value.createdAt, nowIso());
  const updatedAt = stringValue(value.updatedAt, createdAt);
  const rawNodes = Array.isArray(value.nodes)
    ? value.nodes
    : Array.isArray(value.executions)
      ? value.executions
      : [];
  const nodes = rawNodes.flatMap((entry) => {
    const node = normalizeNode(entry, rootExecutionId, createdAt, updatedAt);
    return node ? [node] : [];
  });
  if (nodes.length === 0) {
    throw new Error('Agent execution snapshot does not contain any valid nodes.');
  }
  return {
    version: 1,
    rootExecutionId,
    nodes,
    edges: Array.isArray(value.edges)
      ? value.edges.flatMap((entry) => {
          const edge = normalizeEdge(entry);
          return edge ? [edge] : [];
        })
      : [],
    events: Array.isArray(value.events)
      ? value.events.flatMap((entry) => {
          const event = normalizeEvent(entry);
          return event ? [event] : [];
        }).slice(-MAX_AGENT_EXECUTION_EVENT_HISTORY)
      : [],
    seenEventIds: Array.isArray(value.seenEventIds)
      ? value.seenEventIds
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(-MAX_AGENT_EXECUTION_SEEN_EVENT_IDS)
      : Array.isArray(value.events)
        ? value.events
            .flatMap(entry =>
              isRecord(entry) && typeof entry.eventId === 'string' ? [entry.eventId] : [],
            )
            .slice(-MAX_AGENT_EXECUTION_SEEN_EVENT_IDS)
        : [],
    createdAt,
    updatedAt,
  };
}

function materializeEvent(input: AgentExecutionEvent | AgentExecutionEventDraft): AgentExecutionEvent {
  return {
    ...input,
    eventId:
      typeof input.eventId === 'string' && input.eventId.trim() ? input.eventId : createId(),
    occurredAt:
      typeof input.occurredAt === 'string' && input.occurredAt.trim()
        ? input.occurredAt
        : nowIso(),
  } as AgentExecutionEvent;
}

function sortNodes(nodes: AgentExecutionNode[]): AgentExecutionNode[] {
  return [...nodes].sort(
    (left, right) =>
      left.spawnOrder - right.spawnOrder ||
      left.canonicalPath.localeCompare(right.canonicalPath) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Atomic, per-project persistence for Hadamard's agent execution tree.
 * The constructor receives the same sessionDirectory root used by SessionStore.
 */
export class AgentExecutionStore {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<AgentExecutionStoreListener>>();

  constructor(private readonly sessionDirectory: string) {}

  async upsertEvent(
    input: AgentExecutionEvent | AgentExecutionEventDraft,
  ): Promise<AgentExecutionSnapshot> {
    const event = materializeEvent(input);
    assertSafeStorageSegment('rootExecutionId', event.rootExecutionId);
    return this.enqueue(event.rootExecutionId, () =>
      this.withRootLock(event.rootExecutionId, async () => {
        // Always re-read while holding the cross-process lock. GUI, TUI and
        // CLI processes may project events into the same root concurrently.
        const current = await this.getSnapshot(event.rootExecutionId);
        const next = reduceAgentExecutionEvent(current, event);
        if (next !== current) {
          await writeJsonAtomic(this.snapshotPath(event.rootExecutionId), next);
          this.publish(event.rootExecutionId, {
            event: structuredClone(event),
            snapshot: structuredClone(next),
          });
        }
        return structuredClone(next);
      }),
    );
  }

  subscribe(rootExecutionId: string, listener: AgentExecutionStoreListener): () => void {
    assertSafeStorageSegment('rootExecutionId', rootExecutionId);
    const listeners = this.listeners.get(rootExecutionId) ?? new Set<AgentExecutionStoreListener>();
    listeners.add(listener);
    this.listeners.set(rootExecutionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(rootExecutionId);
      }
    };
  }

  async get(executionId: string): Promise<AgentExecutionNode | undefined> {
    assertSafeStorageSegment('executionId', executionId);
    const direct = await this.getSnapshot(executionId);
    const directNode = direct?.nodes.find((node) => node.id === executionId);
    if (directNode) {
      return directNode;
    }
    const snapshots = await this.listSnapshots();
    return snapshots.flatMap((snapshot) => snapshot.nodes).find((node) => node.id === executionId);
  }

  async getSnapshot(rootExecutionId: string): Promise<AgentExecutionSnapshot | undefined> {
    assertSafeStorageSegment('rootExecutionId', rootExecutionId);
    await this.ensureReady();
    try {
      const raw = await readFile(this.snapshotPath(rootExecutionId), 'utf8');
      return parseSnapshot(raw, rootExecutionId);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<AgentExecutionNode[]> {
    const snapshots = await this.listSnapshots();
    return snapshots
      .flatMap((snapshot) => snapshot.nodes)
      .sort((left, right) => right.timestamps.updatedAt.localeCompare(left.timestamps.updatedAt));
  }

  async listByRoot(rootExecutionId: string): Promise<AgentExecutionNode[]> {
    const snapshot = await this.getSnapshot(rootExecutionId);
    return snapshot ? sortNodes(snapshot.nodes) : [];
  }

  async listSnapshots(): Promise<AgentExecutionSnapshot[]> {
    await this.ensureReady();
    const files = await readdir(this.executionsDirectory());
    const snapshots: AgentExecutionSnapshot[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const rootExecutionId = file.slice(0, -'.json'.length);
      try {
        const raw = await readFile(joinUnderStorageRoot(this.executionsDirectory(), file), 'utf8');
        snapshots.push(parseSnapshot(raw, rootExecutionId));
      } catch (error) {
        console.warn(
          `[AgentExecutionStore] Skipping unreadable execution ${file}: ${(error as Error).message}`,
        );
      }
    }
    return snapshots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private publish(rootExecutionId: string, update: AgentExecutionStoreUpdate): void {
    for (const listener of this.listeners.get(rootExecutionId) ?? []) {
      try {
        listener(update);
      } catch (error) {
        console.warn(
          `[AgentExecutionStore] Listener failed for ${rootExecutionId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async enqueue<T>(rootExecutionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(rootExecutionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(rootExecutionId, settled);
    try {
      return await run;
    } finally {
      if (this.writeQueues.get(rootExecutionId) === settled) {
        this.writeQueues.delete(rootExecutionId);
      }
    }
  }

  private async withRootLock<T>(rootExecutionId: string, action: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    const lockPath = `${this.snapshotPath(rootExecutionId)}.lock`;
    const deadline = Date.now() + EXECUTION_LOCK_TIMEOUT_MS;
    while (true) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, 'wx');
        try {
          return await action();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'EEXIST') throw error;
        await this.removeStaleLock(lockPath);
        if (Date.now() >= deadline) {
          throw new Error(
            `Agent execution ${rootExecutionId} could not acquire its write lock within ${EXECUTION_LOCK_TIMEOUT_MS}ms.`,
          );
        }
        await delay(EXECUTION_LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > EXECUTION_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.executionsDirectory(), { recursive: true });
  }

  private executionsDirectory(): string {
    return joinUnderStorageRoot(this.sessionDirectory, 'agent-executions');
  }

  private snapshotPath(rootExecutionId: string): string {
    return joinUnderStorageRoot(
      this.executionsDirectory(),
      safeStorageFileName('rootExecutionId', rootExecutionId, 'json'),
    );
  }
}
