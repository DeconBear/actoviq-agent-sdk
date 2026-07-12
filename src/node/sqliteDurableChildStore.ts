import type {
  DurableChildRecord,
  DurableChildStore,
} from '../orchestration/background.js';
import {
  StorageConflictError,
  type CheckpointStatus,
  type CheckpointStore,
  type PendingSideEffect,
  type RunCheckpoint,
} from '../storage-v2/index.js';
import { toStorageJson } from './sqliteCheckpointAdapter.js';

export interface SqliteDurableChildStoreOptions {
  readonly store: CheckpointStore;
  readonly tenantId: string;
  readonly prefix?: string;
}

/** SQLite-backed durable child records with storage-level CAS and enumeration. */
export class SqliteDurableChildStore implements DurableChildStore {
  private readonly store: CheckpointStore;
  private readonly tenantId: string;
  private readonly prefix: string;

  constructor(options: SqliteDurableChildStoreOptions) {
    if (!options.tenantId.trim()) throw new TypeError('tenantId must not be empty.');
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.prefix = options.prefix ?? 'orchestration-child:';
  }

  async create(record: DurableChildRecord): Promise<void> {
    if (record.revision !== 0) throw new Error('New durable child revision must be zero.');
    const saved = await this.store.save(this.saveRequest(record, null));
    if (saved.revision !== record.revision) throw new Error('Durable child create revision mismatch.');
  }

  async get(childId: string): Promise<DurableChildRecord | undefined> {
    const checkpoint = await this.store.load({
      tenantId: this.tenantId,
      checkpointId: this.checkpointId(childId),
    });
    return checkpoint ? checkpointToRecord(checkpoint) : undefined;
  }

  async compareAndSet(
    childId: string,
    expectedRevision: number,
    next: DurableChildRecord,
  ): Promise<boolean> {
    if (next.childId !== childId || next.revision !== expectedRevision + 1) {
      throw new Error('Durable child CAS must advance exactly one revision.');
    }
    try {
      const saved = await this.store.save(this.saveRequest(next, expectedRevision));
      return saved.revision === next.revision;
    } catch (error) {
      if (error instanceof StorageConflictError) return false;
      throw error;
    }
  }

  async list(parentRunId?: string): Promise<readonly DurableChildRecord[]> {
    const checkpoints = await this.store.list({ tenantId: this.tenantId, limit: 100_000 });
    return checkpoints
      .filter(checkpoint => checkpoint.checkpointId.startsWith(this.prefix))
      .map(checkpointToRecord)
      .filter(record => parentRunId === undefined || record.parent.runId === parentRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.childId.localeCompare(right.childId));
  }

  private checkpointId(childId: string): string {
    if (!childId.trim()) throw new TypeError('childId must not be empty.');
    return `${this.prefix}${encodeURIComponent(childId)}`;
  }

  private saveRequest(record: DurableChildRecord, expectedRevision: number | null) {
    return {
      tenantId: this.tenantId,
      checkpointId: this.checkpointId(record.childId),
      runId: record.childId,
      sessionId: record.parent.tenantSession.sessionId,
      expectedRevision,
      status: checkpointStatus(record.status),
      state: toStorageJson(record),
      pendingSideEffects: pendingEffects(record),
      traceContext: {
        traceId: record.parent.trace.traceId,
        spanId: record.parent.trace.spanId,
        ...(record.parent.trace.parentSpanId
          ? { parentSpanId: record.parent.trace.parentSpanId }
          : {}),
      },
      updatedAt: record.updatedAt,
    } as const;
  }
}

function checkpointStatus(status: DurableChildRecord['status']): CheckpointStatus {
  return status === 'queued' ? 'running' : status;
}

function pendingEffects(record: DurableChildRecord): PendingSideEffect[] {
  if (record.effect === 'read') return [];
  const status: PendingSideEffect['status'] = record.status === 'queued'
    ? 'pending'
    : record.status === 'running'
      ? 'started'
      : record.status === 'completed'
        ? 'succeeded'
        : record.status === 'failed'
          ? 'failed'
          : 'unknown';
  return [{
    sideEffectId: record.childId,
    kind: `background:${record.agentId}`,
    status,
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    input: toStorageJson(record.input),
    ...(record.result ? { output: toStorageJson(record.result.output) } : {}),
    ...(record.error ? { error: toStorageJson(record.error) } : {}),
  }];
}

function checkpointToRecord(checkpoint: RunCheckpoint): DurableChildRecord {
  if (!isDurableChildRecord(checkpoint.state)) {
    throw new TypeError(`Checkpoint "${checkpoint.checkpointId}" is not a durable child record.`);
  }
  if (checkpoint.state.revision !== checkpoint.revision) {
    throw new TypeError(`Durable child "${checkpoint.state.childId}" revision does not match storage.`);
  }
  return structuredClone(checkpoint.state);
}

function isDurableChildRecord(value: unknown): value is DurableChildRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.childId === 'string'
    && typeof record.revision === 'number'
    && typeof record.parent === 'object'
    && typeof record.agentId === 'string'
    && Array.isArray(record.input)
    && typeof record.status === 'string';
}
