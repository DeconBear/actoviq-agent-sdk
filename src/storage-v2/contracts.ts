import type {
  AppendSessionItemsRequest,
  ArtifactKey,
  ArtifactRecord,
  ArtifactSummary,
  CompactSessionRequest,
  CreateSessionRequest,
  JsonV1MigrationOptions,
  JsonV1MigrationReport,
  ListArtifactsRequest,
  ListMemoryRequest,
  ListRunCheckpointsRequest,
  LoadedSession,
  MemoryKey,
  MemoryRecord,
  PutArtifactRequest,
  PutMemoryRequest,
  RunCheckpoint,
  RunCheckpointKey,
  SaveRunCheckpointRequest,
  SessionKey,
  SessionRecord,
  SessionSnapshot,
  LoadSessionRequest,
} from './types.js';

export interface SessionStoreV2 {
  create(request: CreateSessionRequest): Promise<SessionRecord>;
  get(key: SessionKey): Promise<SessionRecord | undefined>;
  append(request: AppendSessionItemsRequest): Promise<SessionRecord>;
  load(request: LoadSessionRequest): Promise<LoadedSession>;
  compact(request: CompactSessionRequest): Promise<SessionSnapshot>;
}

export interface CheckpointStore {
  save(request: SaveRunCheckpointRequest): Promise<RunCheckpoint>;
  load(key: RunCheckpointKey): Promise<RunCheckpoint | undefined>;
  list(request: ListRunCheckpointsRequest): Promise<RunCheckpoint[]>;
}

export interface MemoryStore {
  put(request: PutMemoryRequest): Promise<MemoryRecord>;
  get(key: MemoryKey): Promise<MemoryRecord | undefined>;
  list(request: ListMemoryRequest): Promise<MemoryRecord[]>;
}

export interface ArtifactStore {
  put(request: PutArtifactRequest): Promise<ArtifactRecord>;
  get(key: ArtifactKey): Promise<ArtifactRecord | undefined>;
  /** Lists metadata only; artifact bytes are loaded explicitly with `get`. */
  list(request: ListArtifactsRequest): Promise<ArtifactSummary[]>;
}

export interface JsonV1Migration {
  migrate(options: JsonV1MigrationOptions): Promise<JsonV1MigrationReport>;
}

export interface DurableStorageV2 {
  readonly sessions: SessionStoreV2;
  readonly checkpoints: CheckpointStore;
  readonly memory: MemoryStore;
  readonly artifacts: ArtifactStore;
  readonly jsonV1Migration: JsonV1Migration;
  close(): Promise<void>;
}
