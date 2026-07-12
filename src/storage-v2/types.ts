export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface TenantResourceKey {
  tenantId: string;
}

export interface SessionKey extends TenantResourceKey {
  sessionId: string;
}

export interface SessionRecord extends SessionKey {
  revision: number;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
}

export interface SessionItemInput {
  itemId: string;
  kind: string;
  payload: JsonValue;
  createdAt?: string;
}

export interface SessionItem extends SessionItemInput {
  sequence: number;
  createdAt: string;
}

export interface SessionSnapshot {
  throughSequence: number;
  revision: number;
  state: JsonValue;
  createdAt: string;
}

export interface LoadedSession {
  session: SessionRecord;
  /** The newest durable snapshot used as the base for `items`, if any. */
  snapshot?: SessionSnapshot;
  /** Items strictly after the snapshot (or after `afterSequence`). */
  items: SessionItem[];
}

export interface CreateSessionRequest extends SessionKey {
  metadata?: JsonObject;
  createdAt?: string;
}

export interface AppendSessionItemsRequest extends SessionKey {
  expectedRevision: number;
  items: readonly SessionItemInput[];
  updatedAt?: string;
}

export interface LoadSessionRequest extends SessionKey {
  /** Bypass the stored snapshot and load items after this sequence. */
  afterSequence?: number;
  /** Set to false to load from sequence zero when `afterSequence` is omitted. */
  useSnapshot?: boolean;
  limit?: number;
}

export interface CompactSessionRequest extends SessionKey {
  expectedRevision: number;
  throughSequence: number;
  state: JsonValue;
  createdAt?: string;
}

export type CheckpointStatus =
  | 'running'
  | 'interrupted'
  | 'awaiting_side_effect'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunInterruption {
  reason: string;
  resumable: boolean;
  requestedAt: string;
  details?: JsonValue;
}

export type PendingSideEffectStatus =
  | 'pending'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/**
 * A durable description of a side effect. Storage records this state but never
 * invokes, retries, or otherwise interprets the operation.
 */
export interface PendingSideEffect {
  sideEffectId: string;
  kind: string;
  status: PendingSideEffectStatus;
  idempotencyKey?: string;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  baggage?: JsonObject;
}

export interface RunCheckpointKey extends TenantResourceKey {
  checkpointId: string;
}

export interface ListRunCheckpointsRequest extends TenantResourceKey {
  runId?: string;
  status?: CheckpointStatus;
  limit?: number;
}

export interface RunCheckpoint extends RunCheckpointKey {
  runId: string;
  sessionId?: string;
  revision: number;
  status: CheckpointStatus;
  state: JsonValue;
  interruption?: RunInterruption;
  pendingSideEffects: PendingSideEffect[];
  traceContext: TraceContext;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRunCheckpointRequest extends RunCheckpointKey {
  runId: string;
  sessionId?: string;
  /** null means create-only; a number means compare-and-swap update. */
  expectedRevision: number | null;
  status: CheckpointStatus;
  state: JsonValue;
  interruption?: RunInterruption;
  pendingSideEffects?: readonly PendingSideEffect[];
  traceContext: TraceContext;
  updatedAt?: string;
}

export interface MemoryKey extends TenantResourceKey {
  memoryId: string;
}

export interface MemoryRecord extends MemoryKey {
  namespace: string;
  revision: number;
  value: JsonValue;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface PutMemoryRequest extends MemoryKey {
  namespace: string;
  expectedRevision: number | null;
  value: JsonValue;
  metadata?: JsonObject;
  updatedAt?: string;
}

export interface ListMemoryRequest extends TenantResourceKey {
  namespace?: string;
  limit?: number;
}

export interface ArtifactKey extends TenantResourceKey {
  artifactId: string;
}

export interface ArtifactSummary extends ArtifactKey {
  revision: number;
  mediaType: string;
  size: number;
  sha256: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord extends ArtifactSummary {
  data: Uint8Array;
}

export interface PutArtifactRequest extends ArtifactKey {
  expectedRevision: number | null;
  mediaType: string;
  data: Uint8Array;
  metadata?: JsonObject;
  updatedAt?: string;
}

export interface ListArtifactsRequest extends TenantResourceKey {
  limit?: number;
}

export interface JsonV1MigrationOptions extends TenantResourceKey {
  sourceDirectory: string;
  /** Stable identity for the source. Defaults to its resolved absolute path. */
  sourceId?: string;
  dryRun?: boolean;
  /** Defaults to a timestamped sibling of sourceDirectory. */
  backupDirectory?: string;
}

export type JsonV1MigrationFileStatus = 'planned' | 'migrated' | 'skipped';

export interface JsonV1MigrationFileResult {
  sourceFile: string;
  sessionId: string;
  itemCount: number;
  status: JsonV1MigrationFileStatus;
}

export interface JsonV1MigrationReport extends TenantResourceKey {
  dryRun: boolean;
  sourceDirectory: string;
  sourceId: string;
  backupDirectory?: string;
  files: JsonV1MigrationFileResult[];
  migratedSessions: number;
  skippedSessions: number;
  totalItems: number;
}
