import type {
  CheckpointStatus,
  CheckpointStore,
  PendingSideEffect,
  RunCheckpoint,
  RunInterruption,
  JsonValue as StorageJsonValue,
} from '../storage-v2/index.js';
import type { RunCheckpointStore, SerializedRunState } from '../runtime-v2/state.js';

export interface SqliteRunCheckpointAdapterOptions {
  readonly store: CheckpointStore;
  readonly tenantId: string;
  readonly checkpointId?: (runId: string) => string;
}

/** Maps runtime-v2 JSON checkpoints onto the tenant-scoped SQLite contract. */
export class SqliteRunCheckpointAdapter implements RunCheckpointStore {
  private readonly store: CheckpointStore;
  private readonly tenantId: string;
  private readonly checkpointId: (runId: string) => string;

  constructor(options: SqliteRunCheckpointAdapterOptions) {
    if (!options.tenantId.trim()) throw new TypeError('tenantId must not be empty.');
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.checkpointId = options.checkpointId ?? (runId => runId);
  }

  async save(state: SerializedRunState): Promise<void> {
    const checkpointId = this.checkpointId(state.runId);
    const current = await this.store.load({ tenantId: this.tenantId, checkpointId });
    const jsonState = toStorageJson(state);
    await this.store.save({
      tenantId: this.tenantId,
      checkpointId,
      runId: state.runId,
      sessionId: state.sessionId,
      expectedRevision: current?.revision ?? null,
      status: mapStatus(state),
      state: jsonState,
      interruption: mapInterruption(state),
      pendingSideEffects: mapPendingSideEffects(state),
      traceContext: {
        traceId: state.trace.traceId,
        spanId: state.trace.spanId,
        ...(state.trace.parentSpanId === undefined
          ? {}
          : { parentSpanId: state.trace.parentSpanId }),
      },
    });
  }

  async load(runId: string): Promise<SerializedRunState | undefined> {
    const checkpoint = await this.store.load({
      tenantId: this.tenantId,
      checkpointId: this.checkpointId(runId),
    });
    if (!checkpoint) return undefined;
    return fromCheckpoint(checkpoint);
  }

  /** Marks the checkpoint completed while retaining an auditable tombstone. */
  async delete(runId: string): Promise<void> {
    const checkpointId = this.checkpointId(runId);
    const current = await this.store.load({ tenantId: this.tenantId, checkpointId });
    if (!current || current.status === 'completed') return;
    await this.store.save({
      tenantId: this.tenantId,
      checkpointId,
      runId: current.runId,
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      status: 'completed',
      state: current.state,
      pendingSideEffects: current.pendingSideEffects,
      traceContext: current.traceContext,
    });
  }
}

function mapStatus(state: SerializedRunState): CheckpointStatus {
  if (state.pendingTool?.status === 'awaiting_approval') return 'awaiting_side_effect';
  return state.status;
}

function mapInterruption(state: SerializedRunState): RunInterruption | undefined {
  const pending = state.pendingTool;
  if (state.status !== 'interrupted' || !pending?.interruptionId) return undefined;
  return {
    reason: 'tool_approval',
    resumable: true,
    requestedAt: new Date().toISOString(),
    details: {
      interruptionId: pending.interruptionId,
      callId: pending.call.id,
      toolName: pending.call.name,
    },
  };
}

function mapPendingSideEffects(state: SerializedRunState): PendingSideEffect[] {
  const pending = state.pendingTool;
  if (!pending || pending.effect === 'read') return [];
  return [{
    sideEffectId: pending.call.id,
    kind: `tool:${pending.call.name}`,
    status: pending.status === 'committed'
      ? 'succeeded'
      : pending.status === 'started'
        ? 'started'
        : 'pending',
    ...(pending.idempotencyKey === undefined ? {} : { idempotencyKey: pending.idempotencyKey }),
    input: toStorageJson(pending.call.input),
    ...(pending.result?.type === 'tool_result'
      ? { output: toStorageJson(pending.result.output) }
      : {}),
  }];
}

export function toStorageJson(value: unknown): StorageJsonValue {
  return toStorageJsonInternal(value, new Set<object>());
}

function fromCheckpoint(checkpoint: RunCheckpoint): SerializedRunState {
  if (!isSerializedRunState(checkpoint.state)) {
    throw new TypeError(`Checkpoint "${checkpoint.checkpointId}" does not contain runtime-v2 state.`);
  }
  return structuredClone(checkpoint.state);
}

function isSerializedRunState(value: unknown): value is SerializedRunState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.runId === 'string'
    && typeof record.agentId === 'string'
    && typeof record.agentConfigDigest === 'string'
    && typeof record.status === 'string'
    && typeof record.trace === 'object'
    && Array.isArray(record.transcript)
    && Array.isArray(record.generatedItems);
}

function toStorageJsonInternal(value: unknown, ancestors: Set<object>): StorageJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Checkpoint contains a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Checkpoint contains non-JSON value ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError('Checkpoint contains a cyclic value.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (entry === undefined) throw new TypeError(`Checkpoint array contains undefined at ${index}.`);
        return toStorageJsonInternal(entry, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Checkpoint contains a non-plain object.');
    }
    const result: Record<string, StorageJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      result[key] = toStorageJsonInternal(entry, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
