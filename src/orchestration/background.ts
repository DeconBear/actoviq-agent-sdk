import { randomUUID } from 'node:crypto';

import {
  assertJsonValue,
  type AgentSpec,
  type InputItem,
  type JsonObject,
  type JsonValue,
} from '../core/index.js';
import type {
  ChildFailurePolicy,
  OrchestrationInput,
  OrchestrationScope,
  PersistedScope,
  SerializedChildError,
  StoredRunResult,
} from './contracts.js';
import { serializeChildError, ChildRunner } from './childRunner.js';
import {
  persistScope,
  restoreScope,
  SemaphoreConcurrencyController,
} from './scope.js';

export type DurableChildStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DurableFailurePolicy =
  | { readonly mode: 'fail-fast' }
  | { readonly mode: 'collect' }
  | { readonly mode: 'retry-safe'; readonly maxAttempts: number };

export interface DurableChildRecord {
  readonly schemaVersion: 1;
  readonly childId: string;
  readonly revision: number;
  readonly parent: PersistedScope;
  readonly agentId: string;
  readonly input: readonly InputItem[];
  readonly context?: JsonValue;
  readonly metadata: Readonly<JsonObject>;
  readonly effect: 'read' | 'idempotent-write' | 'side-effect';
  readonly idempotencyKey?: string;
  readonly failurePolicy: DurableFailurePolicy;
  readonly status: DurableChildStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly result?: StoredRunResult;
  readonly error?: SerializedChildError;
}

export interface DurableChildStore {
  create(record: DurableChildRecord): Promise<void>;
  get(childId: string): Promise<DurableChildRecord | undefined>;
  compareAndSet(
    childId: string,
    expectedRevision: number,
    next: DurableChildRecord,
  ): Promise<boolean>;
  list(parentRunId?: string): Promise<readonly DurableChildRecord[]>;
}

export class InMemoryDurableChildStore implements DurableChildStore {
  private readonly records = new Map<string, DurableChildRecord>();

  create(record: DurableChildRecord): Promise<void> {
    if (this.records.has(record.childId)) {
      return Promise.reject(new Error(`Durable child "${record.childId}" already exists.`));
    }
    this.records.set(record.childId, cloneRecord(record));
    return Promise.resolve();
  }

  get(childId: string): Promise<DurableChildRecord | undefined> {
    const record = this.records.get(childId);
    return Promise.resolve(record ? cloneRecord(record) : undefined);
  }

  compareAndSet(
    childId: string,
    expectedRevision: number,
    next: DurableChildRecord,
  ): Promise<boolean> {
    const current = this.records.get(childId);
    if (!current || current.revision !== expectedRevision) return Promise.resolve(false);
    if (next.childId !== childId || next.revision !== expectedRevision + 1) {
      return Promise.reject(new Error('Durable child CAS must advance exactly one revision.'));
    }
    this.records.set(childId, cloneRecord(next));
    return Promise.resolve(true);
  }

  list(parentRunId?: string): Promise<readonly DurableChildRecord[]> {
    return Promise.resolve([...this.records.values()]
      .filter(record => parentRunId === undefined || record.parent.runId === parentRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.childId.localeCompare(right.childId))
      .map(cloneRecord));
  }
}

export type DurableAgentResolver = (
  agentId: string,
) => AgentSpec<JsonValue | undefined, JsonValue> | undefined
  | Promise<AgentSpec<JsonValue | undefined, JsonValue> | undefined>;

export interface BackgroundChildManagerOptions {
  readonly runner: ChildRunner;
  readonly store: DurableChildStore;
  readonly resolveAgent: DurableAgentResolver;
  readonly leaseMs?: number;
  readonly ownerId?: string;
  readonly now?: () => number;
}

export interface SpawnBackgroundRequest {
  readonly parent: OrchestrationScope;
  readonly agent: AgentSpec<JsonValue | undefined, JsonValue>;
  readonly input: OrchestrationInput;
  readonly context?: JsonValue;
  readonly childId?: string;
  readonly metadata?: Readonly<JsonObject>;
  readonly effect?: DurableChildRecord['effect'];
  readonly idempotencyKey?: string;
  readonly failurePolicy?: DurableFailurePolicy;
  /** False creates a durable queued record for another process to resume. */
  readonly autoStart?: boolean;
}

export class DurableChildHandle {
  constructor(
    readonly childId: string,
    private readonly manager: BackgroundChildManager,
  ) {}

  query(): Promise<DurableChildRecord> {
    return this.manager.query(this.childId);
  }

  result(): Promise<StoredRunResult> {
    return this.manager.result(this.childId);
  }

  async resume(): Promise<this> {
    await this.manager.resume(this.childId);
    return this;
  }

  cancel(reason?: string): Promise<void> {
    return this.manager.cancel(this.childId, reason);
  }
}

/** Durable records are the public handle; in-memory promises are only an optimization. */
export class BackgroundChildManager {
  private readonly runner: ChildRunner;
  private readonly store: DurableChildStore;
  private readonly resolveAgent: DurableAgentResolver;
  private readonly leaseMs: number;
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly flights = new Map<string, Promise<StoredRunResult>>();
  private readonly liveParents = new Map<string, OrchestrationScope>();
  private readonly restoredParents = new Map<string, OrchestrationScope>();

  constructor(options: BackgroundChildManagerOptions) {
    this.runner = options.runner;
    this.store = options.store;
    this.resolveAgent = options.resolveAgent;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) {
      throw new RangeError('Background child leaseMs must be a positive safe integer.');
    }
  }

  async spawn(request: SpawnBackgroundRequest): Promise<DurableChildHandle> {
    if (request.parent.services !== this.runner.runtime.services) {
      throw new Error('Background child parent must share the runner RuntimeServices instance.');
    }
    if (request.context !== undefined) assertJsonValue(request.context, 'Background child context');
    const childId = request.childId ?? randomUUID();
    const now = new Date(this.now()).toISOString();
    const record: DurableChildRecord = {
      schemaVersion: 1,
      childId,
      revision: 0,
      parent: persistScope(request.parent),
      agentId: request.agent.id,
      input: normalizeInput(request.input),
      context: request.context,
      metadata: { ...(request.metadata ?? {}) },
      effect: request.effect ?? 'side-effect',
      idempotencyKey: request.idempotencyKey,
      failurePolicy: request.failurePolicy ?? { mode: 'fail-fast' },
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    validateDurableRetry(record);
    await this.store.create(record);
    this.liveParents.set(request.parent.runId, request.parent);
    const handle = new DurableChildHandle(childId, this);
    if (request.autoStart !== false) this.start(childId);
    return handle;
  }

  handle(childId: string): DurableChildHandle {
    return new DurableChildHandle(childId, this);
  }

  async query(childId: string): Promise<DurableChildRecord> {
    const record = await this.store.get(childId);
    if (!record) throw new Error(`Unknown durable child "${childId}".`);
    return record;
  }

  async resume(childId: string): Promise<DurableChildHandle> {
    this.start(childId);
    return this.handle(childId);
  }

  async result(childId: string): Promise<StoredRunResult> {
    const flight = this.flights.get(childId);
    if (flight) return flight;
    const record = await this.query(childId);
    if (record.status === 'completed' && record.result) return record.result;
    if (record.status === 'failed') {
      throw new Error(`Durable child "${childId}" failed: ${record.error?.message ?? 'unknown error'}`);
    }
    if (record.status === 'cancelled') throw new Error(`Durable child "${childId}" was cancelled.`);
    throw new Error(`Durable child "${childId}" is ${record.status}; call resume() before result().`);
  }

  async cancel(childId: string, reason = 'Background child cancelled.'): Promise<void> {
    this.runner.tree.cancelTree(childId, new Error(reason));
    for (;;) {
      const record = await this.query(childId);
      if (record.status === 'completed' || record.status === 'cancelled') return;
      const next: DurableChildRecord = {
        ...record,
        revision: record.revision + 1,
        status: 'cancelled',
        updatedAt: new Date(this.now()).toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        error: { name: 'AbortError', message: reason, code: 'CANCELLED' },
      };
      if (await this.store.compareAndSet(childId, record.revision, next)) return;
    }
  }

  private start(childId: string): Promise<StoredRunResult> {
    const existing = this.flights.get(childId);
    if (existing) return existing;
    const flight = this.execute(childId).finally(() => {
      if (this.flights.get(childId) === flight) this.flights.delete(childId);
    });
    this.flights.set(childId, flight);
    void flight.catch(() => undefined);
    return flight;
  }

  private async execute(childId: string): Promise<StoredRunResult> {
    const current = await this.query(childId);
    if (current.status === 'completed' && current.result) return current.result;
    if (current.status === 'cancelled') throw new Error(`Durable child "${childId}" was cancelled.`);
    if (current.status === 'failed') {
      throw new Error(`Durable child "${childId}" has failed and cannot be implicitly replayed.`);
    }
    if (current.status === 'running') {
      if ((current.leaseExpiresAt ?? 0) > this.now()) {
        throw new Error(`Durable child "${childId}" is leased by another worker.`);
      }
      assertStaleReplaySafe(current);
    }

    const running: DurableChildRecord = {
      ...current,
      revision: current.revision + 1,
      status: 'running',
      attempts: current.attempts + 1,
      updatedAt: new Date(this.now()).toISOString(),
      leaseOwner: this.ownerId,
      leaseExpiresAt: this.now() + this.leaseMs,
      error: undefined,
    };
    if (!await this.store.compareAndSet(childId, current.revision, running)) {
      throw new Error(`Durable child "${childId}" changed while acquiring its lease.`);
    }

    try {
      const agent = await this.resolveAgent(running.agentId);
      if (!agent) throw new Error(`Cannot resolve durable child agent "${running.agentId}".`);
      const parent = this.parentScope(running.parent);
      const outcome = await this.runner.run({
        parent,
        agent,
        input: running.input,
        context: running.context,
        runId: running.childId,
        metadata: running.metadata,
        effect: running.effect,
        idempotencyKey: running.idempotencyKey,
        failurePolicy: running.failurePolicy as ChildFailurePolicy,
        sessionMode: 'child',
      });
      if (outcome.status === 'failed') {
        await this.finishFailure(running, outcome.error);
        throw new Error(outcome.error.message);
      }
      const result = storeResult(outcome.result);
      await this.finishSuccess(running, result);
      return result;
    } catch (error) {
      await this.finishFailure(running, serializeChildError(error));
      throw error;
    }
  }

  private parentScope(persisted: PersistedScope): OrchestrationScope {
    const live = this.liveParents.get(persisted.runId);
    if (live) return live;
    const restored = this.restoredParents.get(persisted.runId);
    if (restored) return restored;
    const scope = restoreScope(persisted, {
      services: this.runner.runtime.services,
      concurrency: new SemaphoreConcurrencyController(),
    });
    this.restoredParents.set(persisted.runId, scope);
    return scope;
  }

  private async finishSuccess(
    running: DurableChildRecord,
    result: StoredRunResult,
  ): Promise<void> {
    const latest = await this.query(running.childId);
    if (latest.status === 'cancelled') return;
    if (latest.revision !== running.revision || latest.status !== 'running') return;
    await this.store.compareAndSet(running.childId, latest.revision, {
      ...latest,
      revision: latest.revision + 1,
      status: 'completed',
      updatedAt: new Date(this.now()).toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      result,
      error: undefined,
    });
  }

  private async finishFailure(
    running: DurableChildRecord,
    error: SerializedChildError,
  ): Promise<void> {
    const latest = await this.query(running.childId);
    if (latest.status === 'cancelled') return;
    if (latest.revision !== running.revision || latest.status !== 'running') return;
    await this.store.compareAndSet(running.childId, latest.revision, {
      ...latest,
      revision: latest.revision + 1,
      status: 'failed',
      updatedAt: new Date(this.now()).toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error,
    });
  }
}

function validateDurableRetry(record: DurableChildRecord): void {
  if (record.failurePolicy.mode !== 'retry-safe') return;
  if (!Number.isSafeInteger(record.failurePolicy.maxAttempts) || record.failurePolicy.maxAttempts < 2) {
    throw new RangeError('Durable retry-safe maxAttempts must be at least 2.');
  }
  if (record.effect === 'side-effect') {
    throw new Error('Durable retry-safe execution cannot replay a side-effect child.');
  }
  if (record.effect === 'idempotent-write' && !record.idempotencyKey?.trim()) {
    throw new Error('Durable idempotent-write retry requires an idempotencyKey.');
  }
}

function assertStaleReplaySafe(record: DurableChildRecord): void {
  if (record.effect === 'read') return;
  if (record.effect === 'idempotent-write' && record.idempotencyKey?.trim()) return;
  throw new Error(
    `Durable child "${record.childId}" may have committed a side effect; stale execution cannot be replayed.`,
  );
}

function normalizeInput(input: OrchestrationInput): readonly InputItem[] {
  if (typeof input === 'string') return [{ type: 'text', role: 'user', text: input }];
  if (Array.isArray(input)) return structuredClone(input) as readonly InputItem[];
  return [structuredClone(input) as InputItem];
}

function storeResult(result: {
  readonly runId: string;
  readonly agentId: string;
  readonly status: StoredRunResult['status'];
  readonly output: unknown;
  readonly items: StoredRunResult['items'];
  readonly usage: StoredRunResult['usage'];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sessionId?: string;
  readonly metadata?: Readonly<JsonObject>;
}): StoredRunResult {
  assertJsonValue(result.output, 'Durable child output');
  return structuredClone({ ...result, output: result.output });
}

function cloneRecord(record: DurableChildRecord): DurableChildRecord {
  return structuredClone(record);
}
