import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { nodeSqliteDriverFactory, type SqliteDriver } from '../storage-v2/sqliteDriver.js';
import { createId } from '../runtime/helpers.js';
import { normalizeGoal, type GoalSessionPort } from './goalStore.js';
import type { Goal } from './types.js';

export const PROJECT_GOAL_DATABASE = 'goal-state.sqlite';

export interface ProjectGoalSummary {
  id: string;
  objective: string;
  status: Goal['status'];
  revision: number;
  createdAt: string;
  updatedAt: string;
  attachedSessionIds: string[];
}

export interface ProjectGoalEvent {
  id: number;
  goalId: string;
  type: string;
  at: string;
  revision?: number;
  payload?: Record<string, unknown>;
}

/** Project-scoped durable store for Goal snapshots, audit events, and session attachments. */
export class ProjectGoalStore {
  private constructor(private readonly driver: SqliteDriver) {}

  static async open(projectStateDirectory: string): Promise<ProjectGoalStore> {
    await mkdir(projectStateDirectory, { recursive: true });
    const driver = await nodeSqliteDriverFactory.open(
      path.join(projectStateDirectory, PROJECT_GOAL_DATABASE),
    );
    initializeSchema(driver);
    return new ProjectGoalStore(driver);
  }

  close(): void {
    this.driver.close();
  }

  createGoalId(): string {
    return `goal:${createId()}`;
  }

  portForSession(sessionId: string, options: { forceNew?: boolean } = {}): GoalSessionPort {
    const attached = options.forceNew ? undefined : this.goalIdForSession(sessionId);
    const current = options.forceNew ? undefined : attached ?? this.currentGoalId();
    return new ProjectGoalSessionPort(this, sessionId, current);
  }

  importLegacyGoal(sessionId: string, raw: unknown, now = new Date().toISOString()): string | undefined {
    if (this.goalIdForSession(sessionId)) return this.goalIdForSession(sessionId);
    const goal = normalizeGoal(raw, now);
    if (!goal) return undefined;
    const goalId = this.createGoalId();
    this.writeSnapshot(goalId, goal, 'legacy_imported');
    this.attachSession(sessionId, goalId, now);
    return goalId;
  }

  readForSession(sessionId: string): { id: string; goal: Goal } | undefined {
    const goalId = this.goalIdForSession(sessionId) ?? this.currentGoalId();
    if (!goalId) return undefined;
    const goal = this.readSnapshot(goalId);
    return goal ? { id: goalId, goal } : undefined;
  }

  listGoals(options: { includeArchived?: boolean; limit?: number } = {}): ProjectGoalSummary[] {
    const rows = this.driver.prepare(`
      SELECT goal_id, objective, status, revision, created_at, updated_at
      FROM goals
      ${options.includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(options.limit ?? 100, 500)));
    const attachments = this.driver.prepare(
      'SELECT session_id FROM goal_sessions WHERE goal_id = ? ORDER BY attached_at ASC',
    );
    return rows.map(row => ({
      id: String(row.goal_id),
      objective: String(row.objective),
      status: String(row.status) as Goal['status'],
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      attachedSessionIds: attachments.all(String(row.goal_id)).map(item => String(item.session_id)),
    }));
  }

  history(goalId: string, limit = 100): ProjectGoalEvent[] {
    return this.driver.prepare(`
      SELECT event_id, goal_id, event_type, revision, payload_json, created_at
      FROM goal_events
      WHERE goal_id = ?
      ORDER BY event_id DESC
      LIMIT ?
    `).all(goalId, Math.max(1, Math.min(limit, 500))).reverse().map(row => ({
      id: Number(row.event_id),
      goalId: String(row.goal_id),
      type: String(row.event_type),
      at: String(row.created_at),
      ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
      ...(typeof row.payload_json === 'string'
        ? { payload: parseObject(row.payload_json) }
        : {}),
    }));
  }

  goalIdForSession(sessionId: string): string | undefined {
    const row = this.driver.prepare(
      'SELECT goal_id FROM goal_sessions WHERE session_id = ?',
    ).get(sessionId);
    return typeof row?.goal_id === 'string' ? row.goal_id : undefined;
  }

  currentGoalId(): string | undefined {
    const row = this.driver.prepare(`
      SELECT goal_id FROM goals
      WHERE archived_at IS NULL AND status NOT IN ('complete', 'cancelled')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    return typeof row?.goal_id === 'string' ? row.goal_id : undefined;
  }

  readSnapshot(goalId: string): Goal | null {
    const row = this.driver.prepare(
      'SELECT snapshot_json FROM goals WHERE goal_id = ? AND archived_at IS NULL',
    ).get(goalId);
    if (typeof row?.snapshot_json !== 'string') return null;
    return normalizeGoal(row.snapshot_json, new Date().toISOString());
  }

  writeSnapshot(goalId: string, goal: Goal | undefined, eventType = 'snapshot_updated'): void {
    const now = goal?.updatedAt ?? new Date().toISOString();
    this.driver.transaction(() => {
      if (!goal) {
        this.driver.prepare(
          'UPDATE goals SET archived_at = ?, updated_at = ? WHERE goal_id = ?',
        ).run(now, now, goalId);
        this.insertEvent(goalId, 'archived', now);
        return;
      }
      this.driver.prepare(`
        INSERT INTO goals (
          goal_id, objective, status, revision, snapshot_json, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(goal_id) DO UPDATE SET
          objective = excluded.objective,
          status = excluded.status,
          revision = excluded.revision,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at,
          archived_at = NULL
      `).run(
        goalId,
        goal.objective,
        goal.status,
        goal.revision,
        JSON.stringify(goal),
        goal.createdAt,
        goal.updatedAt,
      );
      this.insertEvent(goalId, eventType, now, goal.revision, {
        status: goal.status,
        objective: goal.objective,
      });
    });
  }

  updateSnapshot(
    goalId: string,
    mutation: (current: unknown) => Goal | undefined,
  ): Goal | undefined {
    return this.driver.transaction(() => {
      const current = this.driver.prepare(
        'SELECT snapshot_json FROM goals WHERE goal_id = ? AND archived_at IS NULL',
      ).get(goalId);
      const next = mutation(current?.snapshot_json);
      if (!next) {
        const now = new Date().toISOString();
        this.driver.prepare(
          'UPDATE goals SET archived_at = ?, updated_at = ? WHERE goal_id = ?',
        ).run(now, now, goalId);
        this.insertEvent(goalId, 'archived', now);
        return undefined;
      }
      this.driver.prepare(`
        INSERT INTO goals (
          goal_id, objective, status, revision, snapshot_json, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(goal_id) DO UPDATE SET
          objective = excluded.objective,
          status = excluded.status,
          revision = excluded.revision,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at,
          archived_at = NULL
      `).run(
        goalId,
        next.objective,
        next.status,
        next.revision,
        JSON.stringify(next),
        next.createdAt,
        next.updatedAt,
      );
      this.insertEvent(goalId, 'snapshot_updated', next.updatedAt, next.revision, {
        status: next.status,
      });
      return next;
    });
  }

  attachSession(sessionId: string, goalId: string, at = new Date().toISOString()): void {
    this.driver.prepare(`
      INSERT INTO goal_sessions (session_id, goal_id, attached_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        attached_at = excluded.attached_at
    `).run(sessionId, goalId, at);
    this.insertEvent(goalId, 'session_attached', at, undefined, { sessionId });
  }

  detachSession(sessionId: string, at = new Date().toISOString()): void {
    const goalId = this.goalIdForSession(sessionId);
    this.driver.prepare('DELETE FROM goal_sessions WHERE session_id = ?').run(sessionId);
    if (goalId) this.insertEvent(goalId, 'session_detached', at, undefined, { sessionId });
  }

  private insertEvent(
    goalId: string,
    type: string,
    at: string,
    revision?: number,
    payload?: Record<string, unknown>,
  ): void {
    this.driver.prepare(`
      INSERT INTO goal_events (goal_id, event_type, revision, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(goalId, type, revision ?? null, payload ? JSON.stringify(payload) : null, at);
  }
}

class ProjectGoalSessionPort implements GoalSessionPort {
  private goalId?: string;

  constructor(
    private readonly store: ProjectGoalStore,
    private readonly sessionId: string,
    goalId?: string,
  ) {
    this.goalId = goalId;
  }

  readGoalMetadata(): unknown {
    return this.goalId ? this.store.readSnapshot(this.goalId) : undefined;
  }

  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    if (!this.goalId && value) this.goalId = this.store.createGoalId();
    if (!this.goalId) return;
    this.store.writeSnapshot(this.goalId, value);
    if (value) this.store.attachSession(this.sessionId, this.goalId);
  }

  async updateGoalMetadata(
    mutation: (current: unknown) => Goal | undefined,
  ): Promise<Goal | undefined> {
    if (!this.goalId) {
      const next = mutation(undefined);
      if (!next) return undefined;
      this.goalId = this.store.createGoalId();
      this.store.writeSnapshot(this.goalId, next, 'created');
      this.store.attachSession(this.sessionId, this.goalId, next.createdAt);
      return next;
    }
    const next = this.store.updateSnapshot(this.goalId, mutation);
    if (next) this.store.attachSession(this.sessionId, this.goalId, next.updatedAt);
    return next;
  }
}

function initializeSchema(driver: SqliteDriver): void {
  driver.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_goals_current
      ON goals(archived_at, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS goal_sessions (
      session_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_goal_sessions_goal
      ON goal_sessions(goal_id, attached_at);

    CREATE TABLE IF NOT EXISTS goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      revision INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_goal_events_goal
      ON goal_events(goal_id, event_id);
  `);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
