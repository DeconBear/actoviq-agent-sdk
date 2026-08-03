import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { nodeSqliteDriverFactory, type SqliteDriver } from '../storage-v2/sqliteDriver.js';

const LEASE_MS = 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

export interface DurableMemoryExtractionRecord {
  sessionId: string;
  transcriptVersion: string;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug?: string;
  noOutput: boolean;
  usageCount: number;
  lastUsage?: string;
  generatedAt: string;
}

export interface DurableMemoryConsolidationState {
  artifactHash?: string;
  manifestJson?: string;
  lastSuccessAt?: string;
  completedWatermark?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
}

export class DurableMemoryStore {
  private constructor(private readonly driver: SqliteDriver) {}

  static async open(filename: string): Promise<DurableMemoryStore> {
    await mkdir(path.dirname(filename), { recursive: true });
    const driver = await nodeSqliteDriverFactory.open(filename);
    initializeSchema(driver);
    return new DurableMemoryStore(driver);
  }

  close(): void {
    this.driver.close();
  }

  acquireExtractionLease(input: {
    sessionId: string;
    transcriptVersion: string;
    owner: string;
    now?: Date;
  }): boolean {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const existing = this.driver.prepare(
      'SELECT transcript_version, status, lease_expires_at, next_retry_at FROM rollout_extractions WHERE session_id = ?',
    ).get(input.sessionId);
    if (existing?.transcript_version === input.transcriptVersion && existing.status === 'complete') {
      return false;
    }
    if (isFuture(existing?.lease_expires_at, now) || isFuture(existing?.next_retry_at, now)) {
      return false;
    }
    this.driver.prepare(`
      INSERT INTO rollout_extractions (
        session_id, transcript_version, status, lease_owner, lease_expires_at, attempts, generated_at
      ) VALUES (?, ?, 'leased', ?, ?, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        transcript_version = excluded.transcript_version,
        status = 'leased',
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        next_retry_at = NULL,
        last_error = NULL
    `).run(
      input.sessionId,
      input.transcriptVersion,
      input.owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      nowIso,
    );
    return true;
  }

  completeExtraction(input: {
    sessionId: string;
    owner: string;
    transcriptVersion: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug?: string;
    noOutput: boolean;
    now?: Date;
  }): void {
    const result = this.driver.prepare(`
      UPDATE rollout_extractions SET
        transcript_version = ?, raw_memory = ?, rollout_summary = ?, rollout_slug = ?, no_output = ?,
        status = 'complete', lease_owner = NULL, lease_expires_at = NULL, attempts = 0,
        next_retry_at = NULL, last_error = NULL, generated_at = ?
      WHERE session_id = ? AND lease_owner = ?
    `).run(
      input.transcriptVersion,
      input.rawMemory,
      input.rolloutSummary,
      input.rolloutSlug ?? null,
      input.noOutput ? 1 : 0,
      (input.now ?? new Date()).toISOString(),
      input.sessionId,
      input.owner,
    );
    if (result.changes !== 1) throw new Error(`Durable Memory extraction lease was lost: ${input.sessionId}`);
  }

  failExtraction(sessionId: string, owner: string, error: string, now = new Date()): void {
    const row = this.driver.prepare(
      'SELECT attempts FROM rollout_extractions WHERE session_id = ? AND lease_owner = ?',
    ).get(sessionId, owner);
    if (!row) return;
    const attempts = Number(row.attempts ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    this.driver.prepare(`
      UPDATE rollout_extractions SET
        status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
        attempts = ?, next_retry_at = ?, last_error = ?
      WHERE session_id = ? AND lease_owner = ?
    `).run(
      attempts,
      new Date(now.getTime() + delay).toISOString(),
      error.slice(0, 4_000),
      sessionId,
      owner,
    );
  }

  listConsolidationCandidates(limit = 64, now = new Date()): DurableMemoryExtractionRecord[] {
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    return this.driver.prepare(`
      SELECT session_id, transcript_version, raw_memory, rollout_summary, rollout_slug,
             no_output, usage_count, last_usage, generated_at
      FROM rollout_extractions
      WHERE status = 'complete' AND no_output = 0
        AND COALESCE(last_usage, generated_at) >= ?
      ORDER BY usage_count DESC, COALESCE(last_usage, generated_at) DESC, generated_at DESC
      LIMIT ?
    `).all(cutoff, limit).map(row => ({
      sessionId: String(row.session_id),
      transcriptVersion: String(row.transcript_version),
      rawMemory: String(row.raw_memory ?? ''),
      rolloutSummary: String(row.rollout_summary ?? ''),
      ...(typeof row.rollout_slug === 'string' ? { rolloutSlug: row.rollout_slug } : {}),
      noOutput: Number(row.no_output) === 1,
      usageCount: Number(row.usage_count ?? 0),
      ...(typeof row.last_usage === 'string' ? { lastUsage: row.last_usage } : {}),
      generatedAt: String(row.generated_at),
    }));
  }

  recordUsage(sessionIds: readonly string[], now = new Date()): void {
    const statement = this.driver.prepare(
      'UPDATE rollout_extractions SET usage_count = usage_count + 1, last_usage = ? WHERE session_id = ?',
    );
    this.driver.transaction(() => {
      for (const sessionId of sessionIds) statement.run(now.toISOString(), sessionId);
    });
  }

  activeExtractionLease(now = new Date()): { leaseExpiresAt?: string } | undefined {
    const row = this.driver.prepare(`
      SELECT MAX(lease_expires_at) AS lease_expires_at
      FROM rollout_extractions
      WHERE status = 'leased' AND lease_expires_at > ?
    `).get(now.toISOString());
    return typeof row?.lease_expires_at === 'string'
      ? { leaseExpiresAt: row.lease_expires_at }
      : undefined;
  }

  acquireConsolidationLease(owner: string, now = new Date()): boolean {
    return this.driver.transaction(() => {
      const state = this.consolidationState();
      if (state.leaseOwner && isFuture(state.leaseExpiresAt, now)) return false;
      this.driver.prepare(`
        UPDATE consolidation_state SET lease_owner = ?, lease_expires_at = ?, last_error = NULL WHERE id = 1
      `).run(owner, new Date(now.getTime() + LEASE_MS).toISOString());
      return true;
    });
  }

  releaseConsolidationLease(owner: string, error?: string): void {
    this.driver.prepare(`
      UPDATE consolidation_state SET lease_owner = NULL, lease_expires_at = NULL, last_error = ?
      WHERE id = 1 AND lease_owner = ?
    `).run(error?.slice(0, 4_000) ?? null, owner);
  }

  completeConsolidation(input: {
    owner: string;
    artifactHash: string;
    manifestJson: string;
    watermark?: string;
    now?: Date;
  }): void {
    const result = this.driver.prepare(`
      UPDATE consolidation_state SET artifact_hash = ?, manifest_json = ?, last_success_at = ?,
        completed_watermark = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = 1 AND lease_owner = ?
    `).run(
      input.artifactHash,
      input.manifestJson,
      (input.now ?? new Date()).toISOString(),
      input.watermark ?? null,
      input.owner,
    );
    if (result.changes !== 1) throw new Error('Durable Memory consolidation lease was lost.');
  }

  consolidationState(): DurableMemoryConsolidationState {
    const row = this.driver.prepare('SELECT * FROM consolidation_state WHERE id = 1').get();
    if (!row) return {};
    return {
      ...(typeof row.artifact_hash === 'string' ? { artifactHash: row.artifact_hash } : {}),
      ...(typeof row.manifest_json === 'string' ? { manifestJson: row.manifest_json } : {}),
      ...(typeof row.last_success_at === 'string' ? { lastSuccessAt: row.last_success_at } : {}),
      ...(typeof row.completed_watermark === 'string' ? { completedWatermark: row.completed_watermark } : {}),
      ...(typeof row.lease_owner === 'string' ? { leaseOwner: row.lease_owner } : {}),
      ...(typeof row.lease_expires_at === 'string' ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
    };
  }
}

function initializeSchema(driver: SqliteDriver): void {
  driver.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rollout_extractions (
      session_id TEXT PRIMARY KEY,
      transcript_version TEXT NOT NULL,
      raw_memory TEXT NOT NULL DEFAULT '',
      rollout_summary TEXT NOT NULL DEFAULT '',
      rollout_slug TEXT,
      no_output INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_usage TEXT,
      generated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consolidation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      artifact_hash TEXT,
      manifest_json TEXT,
      last_success_at TEXT,
      completed_watermark TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT
    );
    INSERT OR IGNORE INTO consolidation_state (id) VALUES (1);
  `);
}

function isFuture(value: unknown, now: Date): boolean {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}
