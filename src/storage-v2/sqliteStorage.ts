import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  ArtifactStore,
  CheckpointStore,
  DurableStorageV2,
  MemoryStore,
  SessionStoreV2,
} from './contracts.js';
import {
  StorageConflictError,
  StorageDataError,
  StorageNotFoundError,
} from './errors.js';
import {
  JsonV1Migrator,
  type JsonV1MigrationApplyResult,
  type JsonV1MigrationBackend,
  type JsonV1MigrationLedgerEntry,
  type JsonV1MigrationPlan,
} from './migration.js';
import {
  nodeSqliteDriverFactory,
  type SqliteDriver,
  type SqliteDriverFactory,
} from './sqliteDriver.js';
import type {
  AppendSessionItemsRequest,
  ArtifactKey,
  ArtifactRecord,
  ArtifactSummary,
  CompactSessionRequest,
  CreateSessionRequest,
  JsonObject,
  JsonValue,
  ListArtifactsRequest,
  ListMemoryRequest,
  ListRunCheckpointsRequest,
  LoadedSession,
  LoadSessionRequest,
  MemoryKey,
  MemoryRecord,
  PendingSideEffect,
  PutArtifactRequest,
  PutMemoryRequest,
  RunCheckpoint,
  RunCheckpointKey,
  RunInterruption,
  SaveRunCheckpointRequest,
  SessionItem,
  SessionKey,
  SessionRecord,
  SessionSnapshot,
  TraceContext,
} from './types.js';

const STORAGE_SCHEMA_VERSION = 1;

export interface SqliteStorageV2Options {
  filename: string;
  driverFactory?: SqliteDriverFactory;
}

export class SqliteStorageV2 implements DurableStorageV2, JsonV1MigrationBackend {
  readonly sessions: SessionStoreV2;
  readonly checkpoints: CheckpointStore;
  readonly memory: MemoryStore;
  readonly artifacts: ArtifactStore;
  readonly jsonV1Migration: JsonV1Migrator;

  private closed = false;

  private constructor(private readonly driver: SqliteDriver) {
    initializeSchema(driver);
    this.sessions = new SqliteSessionStore(driver);
    this.checkpoints = new SqliteCheckpointStore(driver);
    this.memory = new SqliteMemoryStore(driver);
    this.artifacts = new SqliteArtifactStore(driver);
    this.jsonV1Migration = new JsonV1Migrator(this);
  }

  static async open(options: SqliteStorageV2Options): Promise<SqliteStorageV2> {
    assertNonEmpty(options.filename, 'filename');
    if (options.filename !== ':memory:') {
      await mkdir(path.dirname(path.resolve(options.filename)), { recursive: true });
    }
    const driver = await (options.driverFactory ?? nodeSqliteDriverFactory).open(options.filename);
    try {
      return new SqliteStorageV2(driver);
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.driver.close();
  }

  /** @internal Used by JsonV1Migrator before the atomic cutover. */
  getJsonV1MigrationEntry(
    tenantId: string,
    sourceId: string,
    sourceKey: string,
  ): JsonV1MigrationLedgerEntry | undefined {
    const row = this.driver.prepare(`
      SELECT content_hash, session_id
      FROM storage_v2_json_v1_migrations
      WHERE tenant_id = ? AND source_id = ? AND source_key = ?
    `).get(tenantId, sourceId, sourceKey);
    if (!row) return undefined;
    return {
      contentHash: readString(row, 'content_hash'),
      sessionId: readString(row, 'session_id'),
    };
  }

  /** @internal Applies sessions, items, and ledger entries as one transaction. */
  applyJsonV1Migration(
    plans: readonly JsonV1MigrationPlan[],
  ): JsonV1MigrationApplyResult[] {
    return this.driver.transaction(() => {
      const results: JsonV1MigrationApplyResult[] = [];
      for (const plan of plans) {
        const ledger = this.getJsonV1MigrationEntry(
          plan.tenantId,
          plan.sourceId,
          plan.sourceKey,
        );
        if (ledger) {
          if (ledger.contentHash !== plan.contentHash || ledger.sessionId !== plan.sessionId) {
            throw new StorageDataError(
              `Previously migrated JSON v1 source changed: ${plan.sourceFile}`,
            );
          }
          results.push({ sourceKey: plan.sourceKey, status: 'skipped' });
          continue;
        }

        const existing = selectSession(this.driver, plan.tenantId, plan.sessionId);
        if (existing) {
          throw new StorageConflictError(
            sessionResource(plan.tenantId, plan.sessionId),
            null,
            existing.revision,
          );
        }
        const revision = plan.items.length > 0 ? 1 : 0;
        this.driver.prepare(`
          INSERT INTO storage_v2_sessions (
            tenant_id, session_id, revision, metadata_json,
            created_at, updated_at, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          plan.tenantId,
          plan.sessionId,
          revision,
          encodeJson(plan.metadata, 'migration metadata'),
          plan.createdAt,
          plan.createdAt,
          plan.items.length,
        );
        const insertItem = this.driver.prepare(`
          INSERT INTO storage_v2_session_items (
            tenant_id, session_id, sequence, item_id, kind, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        plan.items.forEach((item, index) => {
          insertItem.run(
            plan.tenantId,
            plan.sessionId,
            index + 1,
            item.itemId,
            item.kind,
            encodeJson(item.payload, 'migration item payload'),
            item.createdAt ?? plan.createdAt,
          );
        });
        this.driver.prepare(`
          INSERT INTO storage_v2_json_v1_migrations (
            tenant_id, source_id, source_key, content_hash, session_id, migrated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          plan.tenantId,
          plan.sourceId,
          plan.sourceKey,
          plan.contentHash,
          plan.sessionId,
          nowIso(),
        );
        results.push({ sourceKey: plan.sourceKey, status: 'migrated' });
      }
      return results;
    });
  }
}

export class SqliteSessionStore implements SessionStoreV2 {
  constructor(private readonly driver: SqliteDriver) {}

  async create(request: CreateSessionRequest): Promise<SessionRecord> {
    validateSessionKey(request);
    const metadata = request.metadata ?? {};
    const metadataJson = encodeJson(metadata, 'session metadata');
    const createdAt = request.createdAt ?? nowIso();
    assertNonEmpty(createdAt, 'createdAt');

    return this.driver.transaction(() => {
      const existing = selectSession(this.driver, request.tenantId, request.sessionId);
      if (existing) {
        throw new StorageConflictError(
          sessionResource(request.tenantId, request.sessionId),
          null,
          existing.revision,
        );
      }
      this.driver.prepare(`
        INSERT INTO storage_v2_sessions (
          tenant_id, session_id, revision, metadata_json,
          created_at, updated_at, last_sequence
        ) VALUES (?, ?, 0, ?, ?, ?, 0)
      `).run(request.tenantId, request.sessionId, metadataJson, createdAt, createdAt);
      return {
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        revision: 0,
        metadata: cloneJson(metadata),
        createdAt,
        updatedAt: createdAt,
        lastSequence: 0,
      };
    });
  }

  async get(key: SessionKey): Promise<SessionRecord | undefined> {
    validateSessionKey(key);
    return selectSession(this.driver, key.tenantId, key.sessionId);
  }

  async append(request: AppendSessionItemsRequest): Promise<SessionRecord> {
    validateSessionKey(request);
    assertRevision(request.expectedRevision, 'expectedRevision');
    if (request.items.length === 0) {
      throw new StorageDataError('append requires at least one session item');
    }
    const itemIds = new Set<string>();
    const preparedItems = request.items.map((item) => {
      assertNonEmpty(item.itemId, 'itemId');
      assertNonEmpty(item.kind, 'kind');
      if (itemIds.has(item.itemId)) {
        throw new StorageDataError(`Duplicate itemId in append request: ${item.itemId}`);
      }
      itemIds.add(item.itemId);
      return {
        ...item,
        payloadJson: encodeJson(item.payload, `session item ${item.itemId}`),
        createdAt: item.createdAt ?? nowIso(),
      };
    });

    return this.driver.transaction(() => {
      const current = requireSession(this.driver, request.tenantId, request.sessionId);
      assertCas(
        sessionResource(request.tenantId, request.sessionId),
        request.expectedRevision,
        current.revision,
      );
      const insert = this.driver.prepare(`
        INSERT INTO storage_v2_session_items (
          tenant_id, session_id, sequence, item_id, kind, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      preparedItems.forEach((item, index) => {
        insert.run(
          request.tenantId,
          request.sessionId,
          current.lastSequence + index + 1,
          item.itemId,
          item.kind,
          item.payloadJson,
          item.createdAt,
        );
      });
      const nextRevision = current.revision + 1;
      const lastSequence = current.lastSequence + preparedItems.length;
      const updatedAt = request.updatedAt ?? nowIso();
      const result = this.driver.prepare(`
        UPDATE storage_v2_sessions
        SET revision = ?, updated_at = ?, last_sequence = ?
        WHERE tenant_id = ? AND session_id = ? AND revision = ?
      `).run(
        nextRevision,
        updatedAt,
        lastSequence,
        request.tenantId,
        request.sessionId,
        current.revision,
      );
      if (result.changes !== 1) {
        const actual = selectSession(this.driver, request.tenantId, request.sessionId)?.revision ?? null;
        throw new StorageConflictError(
          sessionResource(request.tenantId, request.sessionId),
          request.expectedRevision,
          actual,
        );
      }
      return {
        ...current,
        revision: nextRevision,
        updatedAt,
        lastSequence,
      };
    });
  }

  async load(request: LoadSessionRequest): Promise<LoadedSession> {
    validateSessionKey(request);
    if (request.afterSequence !== undefined) {
      assertSequence(request.afterSequence, 'afterSequence');
    }
    const limit = normalizeLimit(request.limit);
    const session = requireSession(this.driver, request.tenantId, request.sessionId);
    let snapshot: SessionSnapshot | undefined;
    if (request.afterSequence === undefined && request.useSnapshot !== false) {
      const row = this.driver.prepare(`
        SELECT through_sequence, session_revision, state_json, created_at
        FROM storage_v2_session_snapshots
        WHERE tenant_id = ? AND session_id = ?
        ORDER BY through_sequence DESC
        LIMIT 1
      `).get(request.tenantId, request.sessionId);
      if (row) snapshot = rowToSnapshot(row);
    }
    const afterSequence = request.afterSequence ?? snapshot?.throughSequence ?? 0;
    const rows = this.driver.prepare(`
      SELECT sequence, item_id, kind, payload_json, created_at
      FROM storage_v2_session_items
      WHERE tenant_id = ? AND session_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(request.tenantId, request.sessionId, afterSequence, limit);
    return {
      session,
      ...(snapshot ? { snapshot } : {}),
      items: rows.map(rowToSessionItem),
    };
  }

  async compact(request: CompactSessionRequest): Promise<SessionSnapshot> {
    validateSessionKey(request);
    assertRevision(request.expectedRevision, 'expectedRevision');
    assertSequence(request.throughSequence, 'throughSequence');
    const stateJson = encodeJson(request.state, 'session snapshot state');

    return this.driver.transaction(() => {
      const current = requireSession(this.driver, request.tenantId, request.sessionId);
      assertCas(
        sessionResource(request.tenantId, request.sessionId),
        request.expectedRevision,
        current.revision,
      );
      if (request.throughSequence > current.lastSequence) {
        throw new StorageDataError(
          `Snapshot sequence ${request.throughSequence} exceeds session tail ${current.lastSequence}`,
        );
      }
      const latest = this.driver.prepare(`
        SELECT through_sequence
        FROM storage_v2_session_snapshots
        WHERE tenant_id = ? AND session_id = ?
        ORDER BY through_sequence DESC
        LIMIT 1
      `).get(request.tenantId, request.sessionId);
      if (latest && request.throughSequence <= readInteger(latest, 'through_sequence')) {
        throw new StorageDataError('A compacted snapshot must advance throughSequence');
      }
      const revision = current.revision + 1;
      const createdAt = request.createdAt ?? nowIso();
      this.driver.prepare(`
        INSERT INTO storage_v2_session_snapshots (
          tenant_id, session_id, through_sequence,
          session_revision, state_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        request.tenantId,
        request.sessionId,
        request.throughSequence,
        revision,
        stateJson,
        createdAt,
      );
      const result = this.driver.prepare(`
        UPDATE storage_v2_sessions
        SET revision = ?, updated_at = ?
        WHERE tenant_id = ? AND session_id = ? AND revision = ?
      `).run(
        revision,
        createdAt,
        request.tenantId,
        request.sessionId,
        current.revision,
      );
      if (result.changes !== 1) {
        throw new StorageConflictError(
          sessionResource(request.tenantId, request.sessionId),
          request.expectedRevision,
          selectSession(this.driver, request.tenantId, request.sessionId)?.revision ?? null,
        );
      }
      return {
        throughSequence: request.throughSequence,
        revision,
        state: cloneJson(request.state),
        createdAt,
      };
    });
  }
}

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly driver: SqliteDriver) {}

  async save(request: SaveRunCheckpointRequest): Promise<RunCheckpoint> {
    validateCheckpointKey(request);
    assertNonEmpty(request.runId, 'runId');
    if (request.sessionId !== undefined) assertNonEmpty(request.sessionId, 'sessionId');
    if (request.expectedRevision !== null) {
      assertRevision(request.expectedRevision, 'expectedRevision');
    }
    assertNonEmpty(request.traceContext.traceId, 'traceContext.traceId');
    assertNonEmpty(request.traceContext.spanId, 'traceContext.spanId');
    const stateJson = encodeJson(request.state, 'checkpoint state');
    const interruptionJson = request.interruption === undefined
      ? null
      : encodeJson(request.interruption, 'checkpoint interruption');
    const pendingSideEffects = request.pendingSideEffects ?? [];
    for (const effect of pendingSideEffects) {
      assertNonEmpty(effect.sideEffectId, 'pendingSideEffect.sideEffectId');
      assertNonEmpty(effect.kind, 'pendingSideEffect.kind');
    }
    const pendingJson = encodeJson(pendingSideEffects, 'checkpoint pending side effects');
    const traceJson = encodeJson(request.traceContext, 'checkpoint trace context');

    return this.driver.transaction(() => {
      const existingRow = selectCheckpointRow(
        this.driver,
        request.tenantId,
        request.checkpointId,
      );
      const actualRevision = existingRow ? readInteger(existingRow, 'revision') : null;
      if (request.expectedRevision !== actualRevision) {
        throw new StorageConflictError(
          checkpointResource(request.tenantId, request.checkpointId),
          request.expectedRevision,
          actualRevision,
        );
      }
      const updatedAt = request.updatedAt ?? nowIso();
      if (!existingRow) {
        this.driver.prepare(`
          INSERT INTO storage_v2_checkpoints (
            tenant_id, checkpoint_id, run_id, session_id, revision, status,
            state_json, interruption_json, pending_side_effects_json,
            trace_context_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.tenantId,
          request.checkpointId,
          request.runId,
          request.sessionId ?? null,
          request.status,
          stateJson,
          interruptionJson,
          pendingJson,
          traceJson,
          updatedAt,
          updatedAt,
        );
      } else {
        const nextRevision = actualRevision! + 1;
        const result = this.driver.prepare(`
          UPDATE storage_v2_checkpoints
          SET run_id = ?, session_id = ?, revision = ?, status = ?, state_json = ?,
              interruption_json = ?, pending_side_effects_json = ?,
              trace_context_json = ?, updated_at = ?
          WHERE tenant_id = ? AND checkpoint_id = ? AND revision = ?
        `).run(
          request.runId,
          request.sessionId ?? null,
          nextRevision,
          request.status,
          stateJson,
          interruptionJson,
          pendingJson,
          traceJson,
          updatedAt,
          request.tenantId,
          request.checkpointId,
          actualRevision,
        );
        if (result.changes !== 1) {
          throw new StorageConflictError(
            checkpointResource(request.tenantId, request.checkpointId),
            request.expectedRevision,
            selectCheckpointRevision(this.driver, request.tenantId, request.checkpointId),
          );
        }
      }
      return rowToCheckpoint(requireCheckpointRow(
        this.driver,
        request.tenantId,
        request.checkpointId,
      ));
    });
  }

  async load(key: RunCheckpointKey): Promise<RunCheckpoint | undefined> {
    validateCheckpointKey(key);
    const row = selectCheckpointRow(this.driver, key.tenantId, key.checkpointId);
    return row ? rowToCheckpoint(row) : undefined;
  }

  async list(request: ListRunCheckpointsRequest): Promise<RunCheckpoint[]> {
    assertNonEmpty(request.tenantId, 'tenantId');
    if (request.runId !== undefined) assertNonEmpty(request.runId, 'runId');
    const limit = request.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('Checkpoint list limit must be a positive safe integer.');
    }
    const conditions = ['tenant_id = ?'];
    const parameters: unknown[] = [request.tenantId];
    if (request.runId !== undefined) {
      conditions.push('run_id = ?');
      parameters.push(request.runId);
    }
    if (request.status !== undefined) {
      conditions.push('status = ?');
      parameters.push(request.status);
    }
    parameters.push(limit);
    return this.driver.prepare(`
      SELECT * FROM storage_v2_checkpoints
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, checkpoint_id ASC
      LIMIT ?
    `).all(...parameters).map(rowToCheckpoint);
  }
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly driver: SqliteDriver) {}

  async put(request: PutMemoryRequest): Promise<MemoryRecord> {
    validateMemoryKey(request);
    assertNonEmpty(request.namespace, 'namespace');
    if (request.expectedRevision !== null) {
      assertRevision(request.expectedRevision, 'expectedRevision');
    }
    const valueJson = encodeJson(request.value, 'memory value');
    const metadataJson = encodeJson(request.metadata ?? {}, 'memory metadata');

    return this.driver.transaction(() => {
      const existing = selectMemoryRow(this.driver, request.tenantId, request.memoryId);
      const actualRevision = existing ? readInteger(existing, 'revision') : null;
      if (request.expectedRevision !== actualRevision) {
        throw new StorageConflictError(
          memoryResource(request.tenantId, request.memoryId),
          request.expectedRevision,
          actualRevision,
        );
      }
      const updatedAt = request.updatedAt ?? nowIso();
      if (!existing) {
        this.driver.prepare(`
          INSERT INTO storage_v2_memory (
            tenant_id, memory_id, namespace, revision, value_json,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          request.tenantId,
          request.memoryId,
          request.namespace,
          valueJson,
          metadataJson,
          updatedAt,
          updatedAt,
        );
      } else {
        const nextRevision = actualRevision! + 1;
        const result = this.driver.prepare(`
          UPDATE storage_v2_memory
          SET namespace = ?, revision = ?, value_json = ?, metadata_json = ?, updated_at = ?
          WHERE tenant_id = ? AND memory_id = ? AND revision = ?
        `).run(
          request.namespace,
          nextRevision,
          valueJson,
          metadataJson,
          updatedAt,
          request.tenantId,
          request.memoryId,
          actualRevision,
        );
        if (result.changes !== 1) {
          throw new StorageConflictError(
            memoryResource(request.tenantId, request.memoryId),
            request.expectedRevision,
            selectMemoryRevision(this.driver, request.tenantId, request.memoryId),
          );
        }
      }
      return rowToMemory(requireMemoryRow(this.driver, request.tenantId, request.memoryId));
    });
  }

  async get(key: MemoryKey): Promise<MemoryRecord | undefined> {
    validateMemoryKey(key);
    const row = selectMemoryRow(this.driver, key.tenantId, key.memoryId);
    return row ? rowToMemory(row) : undefined;
  }

  async list(request: ListMemoryRequest): Promise<MemoryRecord[]> {
    assertNonEmpty(request.tenantId, 'tenantId');
    const limit = normalizeLimit(request.limit);
    if (request.namespace !== undefined) {
      assertNonEmpty(request.namespace, 'namespace');
      return this.driver.prepare(`
        SELECT * FROM storage_v2_memory
        WHERE tenant_id = ? AND namespace = ?
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT ?
      `).all(request.tenantId, request.namespace, limit).map(rowToMemory);
    }
    return this.driver.prepare(`
      SELECT * FROM storage_v2_memory
      WHERE tenant_id = ?
      ORDER BY updated_at DESC, memory_id ASC
      LIMIT ?
    `).all(request.tenantId, limit).map(rowToMemory);
  }
}

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly driver: SqliteDriver) {}

  async put(request: PutArtifactRequest): Promise<ArtifactRecord> {
    validateArtifactKey(request);
    assertNonEmpty(request.mediaType, 'mediaType');
    if (request.expectedRevision !== null) {
      assertRevision(request.expectedRevision, 'expectedRevision');
    }
    const data = Uint8Array.from(request.data);
    const digest = createHash('sha256').update(data).digest('hex');
    const metadataJson = encodeJson(request.metadata ?? {}, 'artifact metadata');

    return this.driver.transaction(() => {
      const existing = selectArtifactRow(this.driver, request.tenantId, request.artifactId, true);
      const actualRevision = existing ? readInteger(existing, 'revision') : null;
      if (request.expectedRevision !== actualRevision) {
        throw new StorageConflictError(
          artifactResource(request.tenantId, request.artifactId),
          request.expectedRevision,
          actualRevision,
        );
      }
      const updatedAt = request.updatedAt ?? nowIso();
      if (!existing) {
        this.driver.prepare(`
          INSERT INTO storage_v2_artifacts (
            tenant_id, artifact_id, revision, media_type, data, size, sha256,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.tenantId,
          request.artifactId,
          request.mediaType,
          data,
          data.byteLength,
          digest,
          metadataJson,
          updatedAt,
          updatedAt,
        );
      } else {
        const nextRevision = actualRevision! + 1;
        const result = this.driver.prepare(`
          UPDATE storage_v2_artifacts
          SET revision = ?, media_type = ?, data = ?, size = ?, sha256 = ?,
              metadata_json = ?, updated_at = ?
          WHERE tenant_id = ? AND artifact_id = ? AND revision = ?
        `).run(
          nextRevision,
          request.mediaType,
          data,
          data.byteLength,
          digest,
          metadataJson,
          updatedAt,
          request.tenantId,
          request.artifactId,
          actualRevision,
        );
        if (result.changes !== 1) {
          throw new StorageConflictError(
            artifactResource(request.tenantId, request.artifactId),
            request.expectedRevision,
            selectArtifactRevision(this.driver, request.tenantId, request.artifactId),
          );
        }
      }
      return rowToArtifact(requireArtifactRow(
        this.driver,
        request.tenantId,
        request.artifactId,
      ));
    });
  }

  async get(key: ArtifactKey): Promise<ArtifactRecord | undefined> {
    validateArtifactKey(key);
    const row = selectArtifactRow(this.driver, key.tenantId, key.artifactId, true);
    return row ? rowToArtifact(row) : undefined;
  }

  async list(request: ListArtifactsRequest): Promise<ArtifactSummary[]> {
    assertNonEmpty(request.tenantId, 'tenantId');
    const limit = normalizeLimit(request.limit);
    return this.driver.prepare(`
      SELECT tenant_id, artifact_id, revision, media_type, size, sha256,
             metadata_json, created_at, updated_at
      FROM storage_v2_artifacts
      WHERE tenant_id = ?
      ORDER BY updated_at DESC, artifact_id ASC
      LIMIT ?
    `).all(request.tenantId, limit).map(rowToArtifactSummary);
  }
}

function initializeSchema(driver: SqliteDriver): void {
  driver.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS storage_v2_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO storage_v2_schema (singleton, version) VALUES (1, 1);

    CREATE TABLE IF NOT EXISTS storage_v2_sessions (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      PRIMARY KEY (tenant_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS storage_v2_session_items (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id, sequence),
      UNIQUE (tenant_id, session_id, item_id),
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES storage_v2_sessions (tenant_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS storage_v2_session_items_tail
      ON storage_v2_session_items (tenant_id, session_id, sequence);

    CREATE TABLE IF NOT EXISTS storage_v2_session_snapshots (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
      session_revision INTEGER NOT NULL CHECK (session_revision >= 0),
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id, through_sequence),
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES storage_v2_sessions (tenant_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS storage_v2_checkpoints (
      tenant_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      interruption_json TEXT,
      pending_side_effects_json TEXT NOT NULL,
      trace_context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, checkpoint_id)
    );

    CREATE TABLE IF NOT EXISTS storage_v2_memory (
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      value_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS storage_v2_memory_namespace
      ON storage_v2_memory (tenant_id, namespace, updated_at);

    CREATE TABLE IF NOT EXISTS storage_v2_artifacts (
      tenant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      media_type TEXT NOT NULL,
      data BLOB NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, artifact_id)
    );

    CREATE TABLE IF NOT EXISTS storage_v2_json_v1_migrations (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, source_id, source_key)
    );

    CREATE TRIGGER IF NOT EXISTS storage_v2_session_items_no_update
    BEFORE UPDATE ON storage_v2_session_items
    BEGIN
      SELECT RAISE(ABORT, 'storage_v2 session items are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS storage_v2_session_items_no_delete
    BEFORE DELETE ON storage_v2_session_items
    BEGIN
      SELECT RAISE(ABORT, 'storage_v2 session items are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS storage_v2_snapshots_no_update
    BEFORE UPDATE ON storage_v2_session_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'storage_v2 session snapshots are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS storage_v2_snapshots_no_delete
    BEFORE DELETE ON storage_v2_session_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'storage_v2 session snapshots are append-only');
    END;
  `);
  const row = driver.prepare(
    'SELECT version FROM storage_v2_schema WHERE singleton = 1',
  ).get();
  const version = row ? readInteger(row, 'version') : -1;
  if (version !== STORAGE_SCHEMA_VERSION) {
    throw new StorageDataError(`Unsupported storage-v2 schema version ${version}`);
  }
}

function selectSession(
  driver: SqliteDriver,
  tenantId: string,
  sessionId: string,
): SessionRecord | undefined {
  const row = driver.prepare(`
    SELECT tenant_id, session_id, revision, metadata_json,
           created_at, updated_at, last_sequence
    FROM storage_v2_sessions
    WHERE tenant_id = ? AND session_id = ?
  `).get(tenantId, sessionId);
  return row ? rowToSession(row) : undefined;
}

function requireSession(driver: SqliteDriver, tenantId: string, sessionId: string): SessionRecord {
  const session = selectSession(driver, tenantId, sessionId);
  if (!session) throw new StorageNotFoundError(sessionResource(tenantId, sessionId));
  return session;
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    tenantId: readString(row, 'tenant_id'),
    sessionId: readString(row, 'session_id'),
    revision: readInteger(row, 'revision'),
    metadata: decodeJson<JsonObject>(readString(row, 'metadata_json'), 'session metadata'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
    lastSequence: readInteger(row, 'last_sequence'),
  };
}

function rowToSessionItem(row: Record<string, unknown>): SessionItem {
  return {
    sequence: readInteger(row, 'sequence'),
    itemId: readString(row, 'item_id'),
    kind: readString(row, 'kind'),
    payload: decodeJson<JsonValue>(readString(row, 'payload_json'), 'session item payload'),
    createdAt: readString(row, 'created_at'),
  };
}

function rowToSnapshot(row: Record<string, unknown>): SessionSnapshot {
  return {
    throughSequence: readInteger(row, 'through_sequence'),
    revision: readInteger(row, 'session_revision'),
    state: decodeJson<JsonValue>(readString(row, 'state_json'), 'session snapshot state'),
    createdAt: readString(row, 'created_at'),
  };
}

function selectCheckpointRow(
  driver: SqliteDriver,
  tenantId: string,
  checkpointId: string,
): Record<string, unknown> | undefined {
  return driver.prepare(`
    SELECT * FROM storage_v2_checkpoints
    WHERE tenant_id = ? AND checkpoint_id = ?
  `).get(tenantId, checkpointId);
}

function requireCheckpointRow(
  driver: SqliteDriver,
  tenantId: string,
  checkpointId: string,
): Record<string, unknown> {
  const row = selectCheckpointRow(driver, tenantId, checkpointId);
  if (!row) throw new StorageNotFoundError(checkpointResource(tenantId, checkpointId));
  return row;
}

function selectCheckpointRevision(
  driver: SqliteDriver,
  tenantId: string,
  checkpointId: string,
): number | null {
  const row = selectCheckpointRow(driver, tenantId, checkpointId);
  return row ? readInteger(row, 'revision') : null;
}

function rowToCheckpoint(row: Record<string, unknown>): RunCheckpoint {
  const interruptionRaw = readNullableString(row, 'interruption_json');
  return {
    tenantId: readString(row, 'tenant_id'),
    checkpointId: readString(row, 'checkpoint_id'),
    runId: readString(row, 'run_id'),
    ...(readNullableString(row, 'session_id') !== undefined
      ? { sessionId: readNullableString(row, 'session_id') }
      : {}),
    revision: readInteger(row, 'revision'),
    status: readString(row, 'status') as RunCheckpoint['status'],
    state: decodeJson<JsonValue>(readString(row, 'state_json'), 'checkpoint state'),
    ...(interruptionRaw !== undefined
      ? { interruption: decodeJson<RunInterruption>(interruptionRaw, 'checkpoint interruption') }
      : {}),
    pendingSideEffects: decodeJson<PendingSideEffect[]>(
      readString(row, 'pending_side_effects_json'),
      'checkpoint pending side effects',
    ),
    traceContext: decodeJson<TraceContext>(
      readString(row, 'trace_context_json'),
      'checkpoint trace context',
    ),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function selectMemoryRow(
  driver: SqliteDriver,
  tenantId: string,
  memoryId: string,
): Record<string, unknown> | undefined {
  return driver.prepare(`
    SELECT * FROM storage_v2_memory
    WHERE tenant_id = ? AND memory_id = ?
  `).get(tenantId, memoryId);
}

function requireMemoryRow(
  driver: SqliteDriver,
  tenantId: string,
  memoryId: string,
): Record<string, unknown> {
  const row = selectMemoryRow(driver, tenantId, memoryId);
  if (!row) throw new StorageNotFoundError(memoryResource(tenantId, memoryId));
  return row;
}

function selectMemoryRevision(
  driver: SqliteDriver,
  tenantId: string,
  memoryId: string,
): number | null {
  const row = selectMemoryRow(driver, tenantId, memoryId);
  return row ? readInteger(row, 'revision') : null;
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    tenantId: readString(row, 'tenant_id'),
    memoryId: readString(row, 'memory_id'),
    namespace: readString(row, 'namespace'),
    revision: readInteger(row, 'revision'),
    value: decodeJson<JsonValue>(readString(row, 'value_json'), 'memory value'),
    metadata: decodeJson<JsonObject>(readString(row, 'metadata_json'), 'memory metadata'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function selectArtifactRow(
  driver: SqliteDriver,
  tenantId: string,
  artifactId: string,
  includeData: boolean,
): Record<string, unknown> | undefined {
  return driver.prepare(`
    SELECT tenant_id, artifact_id, revision, media_type,
           ${includeData ? 'data,' : ''} size, sha256, metadata_json, created_at, updated_at
    FROM storage_v2_artifacts
    WHERE tenant_id = ? AND artifact_id = ?
  `).get(tenantId, artifactId);
}

function requireArtifactRow(
  driver: SqliteDriver,
  tenantId: string,
  artifactId: string,
): Record<string, unknown> {
  const row = selectArtifactRow(driver, tenantId, artifactId, true);
  if (!row) throw new StorageNotFoundError(artifactResource(tenantId, artifactId));
  return row;
}

function selectArtifactRevision(
  driver: SqliteDriver,
  tenantId: string,
  artifactId: string,
): number | null {
  const row = selectArtifactRow(driver, tenantId, artifactId, false);
  return row ? readInteger(row, 'revision') : null;
}

function rowToArtifactSummary(row: Record<string, unknown>): ArtifactSummary {
  return {
    tenantId: readString(row, 'tenant_id'),
    artifactId: readString(row, 'artifact_id'),
    revision: readInteger(row, 'revision'),
    mediaType: readString(row, 'media_type'),
    size: readInteger(row, 'size'),
    sha256: readString(row, 'sha256'),
    metadata: decodeJson<JsonObject>(readString(row, 'metadata_json'), 'artifact metadata'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    ...rowToArtifactSummary(row),
    data: readBytes(row, 'data'),
  };
}

function validateSessionKey(key: SessionKey): void {
  assertNonEmpty(key.tenantId, 'tenantId');
  assertNonEmpty(key.sessionId, 'sessionId');
}

function validateCheckpointKey(key: RunCheckpointKey): void {
  assertNonEmpty(key.tenantId, 'tenantId');
  assertNonEmpty(key.checkpointId, 'checkpointId');
}

function validateMemoryKey(key: MemoryKey): void {
  assertNonEmpty(key.tenantId, 'tenantId');
  assertNonEmpty(key.memoryId, 'memoryId');
}

function validateArtifactKey(key: ArtifactKey): void {
  assertNonEmpty(key.tenantId, 'tenantId');
  assertNonEmpty(key.artifactId, 'artifactId');
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StorageDataError(`${field} must be a non-empty string`);
  }
}

function assertRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageDataError(`${field} must be a non-negative safe integer`);
  }
}

function assertSequence(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageDataError(`${field} must be a non-negative safe integer`);
  }
}

function assertCas(resource: string, expected: number, actual: number): void {
  if (expected !== actual) throw new StorageConflictError(resource, expected, actual);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return -1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StorageDataError('limit must be a positive safe integer');
  }
  return value;
}

function encodeJson(value: unknown, label: string): string {
  assertJsonValue(value, label, new Set<object>());
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new StorageDataError(`${label} cannot be serialized as JSON`, { cause: error });
  }
}

function decodeJson<T>(raw: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new StorageDataError(`${label} contains invalid JSON`, { cause: error });
  }
  assertJsonValue(value, label, new Set<object>());
  return value as T;
}

function cloneJson<T>(value: T): T {
  return decodeJson<T>(encodeJson(value, 'JSON value'), 'JSON value');
}

function assertJsonValue(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StorageDataError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') {
    throw new StorageDataError(`${label} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw new StorageDataError(`${label} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StorageDataError(`${label} contains a non-plain object`);
    }
    for (const item of Object.values(value)) assertJsonValue(item, label, ancestors);
  }
  ancestors.delete(value);
}

function readString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw corruptRow(field, 'string');
  return value;
}

function readNullableString(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw corruptRow(field, 'string or null');
  return value;
}

function readInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw corruptRow(field, 'safe integer');
  }
  return normalized;
}

function readBytes(row: Record<string, unknown>, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw corruptRow(field, 'BLOB');
  return Uint8Array.from(value);
}

function corruptRow(field: string, expected: string): StorageDataError {
  return new StorageDataError(`SQLite row field ${field} must be ${expected}`);
}

function sessionResource(tenantId: string, sessionId: string): string {
  return `session ${tenantId}/${sessionId}`;
}

function checkpointResource(tenantId: string, checkpointId: string): string {
  return `checkpoint ${tenantId}/${checkpointId}`;
}

function memoryResource(tenantId: string, memoryId: string): string {
  return `memory ${tenantId}/${memoryId}`;
}

function artifactResource(tenantId: string, artifactId: string): string {
  return `artifact ${tenantId}/${artifactId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
