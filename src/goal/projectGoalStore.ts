import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { nodeSqliteDriverFactory, type SqliteDriver } from '../storage-v2/sqliteDriver.js';
import { createId } from '../runtime/helpers.js';
import { normalizeGoal, type GoalSessionPort } from './goalStore.js';
import type { Goal } from './types.js';
import type { GoalHandoffReceipt, GoalWorkClaim } from './types.js';

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

export type GoalContinuationMode = 'manual' | 'foreground' | 'scheduled';

export interface GoalContinuationProfileRef {
  kind: 'config' | 'agent';
  name: string;
}

export interface GoalContinuationState {
  goalId: string;
  mode: GoalContinuationMode;
  executionProfile?: GoalContinuationProfileRef;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  currentIntervalSeconds: number;
  nextWakeAt?: string;
  lastWakeAt?: string;
  lastOutcome?: string;
  consecutiveNoChange: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  sessionId?: string;
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

  continuationState(goalId: string): GoalContinuationState | undefined {
    const row = this.driver.prepare(`
      SELECT c.*, (
        SELECT session_id FROM goal_sessions s
        WHERE s.goal_id = c.goal_id ORDER BY attached_at DESC LIMIT 1
      ) AS session_id
      FROM goal_continuation c WHERE c.goal_id = ?
    `).get(goalId);
    return row ? mapContinuation(row) : undefined;
  }

  listScheduledContinuations(): GoalContinuationState[] {
    return this.driver.prepare(`
      SELECT c.*, (
        SELECT session_id FROM goal_sessions s
        WHERE s.goal_id = c.goal_id ORDER BY attached_at DESC LIMIT 1
      ) AS session_id
      FROM goal_continuation c
      JOIN goals g ON g.goal_id = c.goal_id
      WHERE c.mode = 'scheduled' AND g.archived_at IS NULL AND g.status = 'active'
      ORDER BY COALESCE(c.next_wake_at, g.updated_at) ASC
    `).all().map(mapContinuation);
  }

  configureContinuation(input: {
    goalId: string;
    mode: GoalContinuationMode;
    executionProfile?: GoalContinuationProfileRef;
    minIntervalSeconds?: number;
    maxIntervalSeconds?: number;
    now?: Date;
  }): GoalContinuationState {
    const now = input.now ?? new Date();
    const min = clampSeconds(input.minIntervalSeconds ?? 30, 1, 86_400);
    const max = clampSeconds(input.maxIntervalSeconds ?? 1_800, min, 604_800);
    const current = this.continuationState(input.goalId);
    const interval = Math.max(min, Math.min(current?.currentIntervalSeconds ?? min, max));
    const nextWakeAt = input.mode === 'scheduled'
      ? new Date(now.getTime() + interval * 1_000).toISOString()
      : null;
    this.driver.prepare(`
      INSERT INTO goal_continuation (
        goal_id, mode, execution_profile_json, min_interval_seconds, max_interval_seconds,
        current_interval_seconds, next_wake_at, consecutive_no_change, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(goal_id) DO UPDATE SET
        mode = excluded.mode,
        execution_profile_json = excluded.execution_profile_json,
        min_interval_seconds = excluded.min_interval_seconds,
        max_interval_seconds = excluded.max_interval_seconds,
        current_interval_seconds = excluded.current_interval_seconds,
        next_wake_at = excluded.next_wake_at,
        updated_at = excluded.updated_at,
        last_error = NULL
    `).run(
      input.goalId,
      input.mode,
      input.executionProfile ? JSON.stringify(input.executionProfile) : null,
      min,
      max,
      interval,
      nextWakeAt,
      now.toISOString(),
    );
    this.insertEvent(input.goalId, 'continuation_configured', now.toISOString(), undefined, {
      mode: input.mode,
      ...(input.executionProfile ? { executionProfile: input.executionProfile } : {}),
    });
    return this.continuationState(input.goalId)!;
  }

  acquireContinuationLease(goalId: string, owner: string, now = new Date(), leaseMs = 15 * 60_000): boolean {
    return this.driver.transaction(() => {
      const state = this.continuationState(goalId);
      if (!state) return false;
      if (state.leaseOwner && isFuture(state.leaseExpiresAt, now)) return false;
      const result = this.driver.prepare(`
        UPDATE goal_continuation SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE goal_id = ?
      `).run(
        owner,
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        goalId,
      );
      return result.changes === 1;
    });
  }

  settleContinuation(input: {
    goalId: string;
    owner: string;
    outcome: string;
    error?: string;
    now?: Date;
  }): GoalContinuationState | undefined {
    const now = input.now ?? new Date();
    const current = this.continuationState(input.goalId);
    if (!current || current.leaseOwner !== input.owner) return current;
    // Replan attempts are not "no progress" — only true stalls back off.
    const noChange = input.outcome === 'no_change'
      || input.outcome === 'failed'
      || input.outcome === 'interrupted'
      || input.outcome === 'validation_failed'
      || Boolean(input.error);
    const interval = noChange
      ? Math.min(current.maxIntervalSeconds, Math.max(current.minIntervalSeconds, current.currentIntervalSeconds * 2))
      : Math.max(current.minIntervalSeconds, Math.floor(current.currentIntervalSeconds / 2));
    const nextWakeAt = current.mode === 'scheduled'
      ? new Date(now.getTime() + interval * 1_000).toISOString()
      : null;
    this.driver.prepare(`
      UPDATE goal_continuation SET
        current_interval_seconds = ?, next_wake_at = ?, last_wake_at = ?, last_outcome = ?,
        consecutive_no_change = ?, lease_owner = NULL, lease_expires_at = NULL,
        last_error = ?, updated_at = ?
      WHERE goal_id = ? AND lease_owner = ?
    `).run(
      interval,
      nextWakeAt,
      now.toISOString(),
      input.outcome,
      noChange ? current.consecutiveNoChange + 1 : 0,
      input.error?.slice(0, 4_000) ?? null,
      now.toISOString(),
      input.goalId,
      input.owner,
    );
    this.insertEvent(input.goalId, input.error ? 'continuation_failed' : 'continuation_settled', now.toISOString(), undefined, {
      outcome: input.outcome,
      intervalSeconds: interval,
      ...(input.error ? { error: input.error.slice(0, 4_000) } : {}),
    });
    return this.continuationState(input.goalId);
  }

  claimNextWork(input: {
    goalId: string;
    agentId: string;
    roleScopes?: string[];
    leaseMs?: number;
    now?: Date;
  }): GoalWorkClaim | undefined {
    const now = input.now ?? new Date();
    const roleScopes = unique(input.roleScopes ?? []);
    return this.driver.transaction(() => {
      const goal = this.readSnapshot(input.goalId);
      if (!goal || goal.status !== 'active') return undefined;
      const completed = new Set(goal.workItems
        .filter(item => item.status === 'done' || item.status === 'cancelled')
        .map(item => item.id));
      const claims = new Map(this.driver.prepare(`
        SELECT * FROM goal_work_claims WHERE goal_id = ? AND lease_expires_at > ?
      `).all(input.goalId, now.toISOString()).map(row => [String(row.work_item_id), row]));
      const candidate = [...goal.workItems]
        .filter(item => (
          item.role === 'agent'
          && ['open', 'claimed', 'running'].includes(item.status)
          && item.dependsOn.every(id => completed.has(id))
          && !claims.has(item.id)
          && !(item.excludedAgentIds ?? []).includes(input.agentId)
          && ((item.roleScopes ?? []).length === 0
            || (item.roleScopes ?? []).some(scope => roleScopes.includes(scope)))
        ))
        .sort(compareGoalWorkItems)[0];
      if (!candidate) return undefined;
      const claimedAt = now.toISOString();
      const claim: GoalWorkClaim = {
        goalId: input.goalId,
        workItemId: candidate.id,
        agentId: input.agentId,
        claimToken: `goal-claim:${createId()}`,
        roleScopes,
        claimedAt,
        leaseExpiresAt: new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 15 * 60_000)).toISOString(),
        updatedAt: claimedAt,
      };
      this.driver.prepare(`
        INSERT INTO goal_work_claims (
          goal_id, work_item_id, agent_id, claim_token, role_scopes_json,
          claimed_at, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, work_item_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          claim_token = excluded.claim_token,
          role_scopes_json = excluded.role_scopes_json,
          claimed_at = excluded.claimed_at,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
        WHERE goal_work_claims.lease_expires_at <= ?
      `).run(
        claim.goalId,
        claim.workItemId,
        claim.agentId,
        claim.claimToken,
        JSON.stringify(claim.roleScopes),
        claim.claimedAt,
        claim.leaseExpiresAt,
        claim.updatedAt,
        claimedAt,
      );
      this.insertEvent(input.goalId, 'work_claimed', claimedAt, undefined, {
        workItemId: candidate.id,
        agentId: input.agentId,
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      return claim;
    });
  }

  renewWorkClaim(claimToken: string, leaseMs = 15 * 60_000, now = new Date()): GoalWorkClaim | undefined {
    const row = this.driver.prepare(
      'SELECT * FROM goal_work_claims WHERE claim_token = ? AND lease_expires_at > ?',
    ).get(claimToken, now.toISOString());
    if (!row) return undefined;
    const leaseExpiresAt = new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString();
    this.driver.prepare(`
      UPDATE goal_work_claims SET lease_expires_at = ?, updated_at = ? WHERE claim_token = ?
    `).run(leaseExpiresAt, now.toISOString(), claimToken);
    return mapWorkClaim({ ...row, lease_expires_at: leaseExpiresAt, updated_at: now.toISOString() });
  }

  markClaimRunning(claimToken: string, now = new Date()): boolean {
    const row = this.driver.prepare(
      'SELECT goal_id, work_item_id FROM goal_work_claims WHERE claim_token = ? AND lease_expires_at > ?',
    ).get(claimToken, now.toISOString());
    if (!row) return false;
    let changed = false;
    this.updateSnapshot(String(row.goal_id), raw => {
      const goal = normalizeGoal(raw, now.toISOString());
      if (!goal) return undefined;
      const workItems = goal.workItems.map(item => {
        if (item.id !== String(row.work_item_id)) return item;
        changed = true;
        return { ...item, status: 'running' as const, updatedAt: now.toISOString() };
      });
      return changed ? {
        ...goal,
        workItems,
        updatedAt: now.toISOString(),
        revision: goal.revision + 1,
      } : goal;
    });
    return changed;
  }

  releaseWorkClaim(claimToken: string, reason = 'released', now = new Date()): boolean {
    const row = this.driver.prepare(
      'SELECT goal_id, work_item_id, agent_id FROM goal_work_claims WHERE claim_token = ?',
    ).get(claimToken);
    if (!row) return false;
    const result = this.driver.prepare('DELETE FROM goal_work_claims WHERE claim_token = ?').run(claimToken);
    if (result.changes === 1) {
      this.updateSnapshot(String(row.goal_id), raw => {
        const goal = normalizeGoal(raw, now.toISOString());
        if (!goal) return undefined;
        let changed = false;
        const workItems = goal.workItems.map(item => {
          if (item.id !== String(row.work_item_id)) return item;
          if (item.status !== 'running' && item.status !== 'claimed') return item;
          changed = true;
          return { ...item, status: 'open' as const, updatedAt: now.toISOString() };
        });
        return changed ? {
          ...goal,
          workItems,
          updatedAt: now.toISOString(),
          revision: goal.revision + 1,
        } : goal;
      });
      this.insertEvent(String(row.goal_id), 'work_claim_released', now.toISOString(), undefined, {
        workItemId: String(row.work_item_id),
        agentId: String(row.agent_id),
        reason,
      });
    }
    return result.changes === 1;
  }

  /** Atomically claim a specific work item if it is runnable and unclaimed. */
  claimWorkItem(input: {
    goalId: string;
    workItemId: string;
    agentId: string;
    roleScopes?: string[];
    leaseMs?: number;
    now?: Date;
  }): GoalWorkClaim | undefined {
    const now = input.now ?? new Date();
    const roleScopes = unique(input.roleScopes ?? []);
    return this.driver.transaction(() => {
      const goal = this.readSnapshot(input.goalId);
      if (!goal || goal.status !== 'active') return undefined;
      const completed = new Set(goal.workItems
        .filter(item => item.status === 'done' || item.status === 'cancelled')
        .map(item => item.id));
      const existing = this.driver.prepare(`
        SELECT * FROM goal_work_claims WHERE goal_id = ? AND work_item_id = ? AND lease_expires_at > ?
      `).get(input.goalId, input.workItemId, now.toISOString());
      if (existing) {
        return String(existing.agent_id) === input.agentId ? mapWorkClaim(existing) : undefined;
      }
      const item = goal.workItems.find(candidate => candidate.id === input.workItemId);
      if (
        !item
        || item.role !== 'agent'
        || !['open', 'claimed', 'running'].includes(item.status)
        || !item.dependsOn.every(id => completed.has(id))
        || (item.excludedAgentIds ?? []).includes(input.agentId)
      ) {
        return undefined;
      }
      // Empty roleScopes = session owner / unrestricted claimant.
      if (
        roleScopes.length > 0
        && (item.roleScopes ?? []).length > 0
        && !(item.roleScopes ?? []).some(scope => roleScopes.includes(scope))
      ) {
        return undefined;
      }
      const claimedAt = now.toISOString();
      const claim: GoalWorkClaim = {
        goalId: input.goalId,
        workItemId: item.id,
        agentId: input.agentId,
        claimToken: `goal-claim:${createId()}`,
        roleScopes,
        claimedAt,
        leaseExpiresAt: new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 15 * 60_000)).toISOString(),
        updatedAt: claimedAt,
      };
      const result = this.driver.prepare(`
        INSERT INTO goal_work_claims (
          goal_id, work_item_id, agent_id, claim_token, role_scopes_json,
          claimed_at, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, work_item_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          claim_token = excluded.claim_token,
          role_scopes_json = excluded.role_scopes_json,
          claimed_at = excluded.claimed_at,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
        WHERE goal_work_claims.lease_expires_at <= ?
      `).run(
        claim.goalId,
        claim.workItemId,
        claim.agentId,
        claim.claimToken,
        JSON.stringify(claim.roleScopes),
        claim.claimedAt,
        claim.leaseExpiresAt,
        claim.updatedAt,
        claimedAt,
      );
      if (result.changes !== 1) return undefined;
      this.insertEvent(input.goalId, 'work_claimed', claimedAt, undefined, {
        workItemId: claim.workItemId,
        agentId: input.agentId,
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      return claim;
    });
  }

  completeWorkClaim(claimToken: string, evidenceRefs: string[], now = new Date()): boolean {
    const refs = unique(evidenceRefs);
    if (refs.length === 0) return false;
    const row = this.driver.prepare(
      'SELECT goal_id, work_item_id, agent_id FROM goal_work_claims WHERE claim_token = ? AND lease_expires_at > ?',
    ).get(claimToken, now.toISOString());
    if (!row) return false;
    let changed = false;
    this.updateSnapshot(String(row.goal_id), raw => {
      const goal = normalizeGoal(raw, now.toISOString());
      if (!goal) return undefined;
      const workItems = goal.workItems.map(item => {
        if (item.id !== String(row.work_item_id) || item.status === 'done') return item;
        changed = true;
        return {
          ...item,
          status: 'done' as const,
          evidenceRefs: unique([...item.evidenceRefs, ...refs]),
          updatedAt: now.toISOString(),
        };
      });
      return changed ? {
        ...goal,
        workItems,
        delivery: {
          ...goal.delivery,
          completedWorkItems: goal.delivery.completedWorkItems + 1,
        },
        planRevision: goal.planRevision + 1,
        updatedAt: now.toISOString(),
        revision: goal.revision + 1,
      } : goal;
    });
    if (!changed) return false;
    this.driver.prepare('DELETE FROM goal_work_claims WHERE claim_token = ?').run(claimToken);
    this.insertEvent(String(row.goal_id), 'work_claim_completed', now.toISOString(), undefined, {
      workItemId: String(row.work_item_id),
      agentId: String(row.agent_id),
      evidenceRefs: refs,
    });
    return true;
  }

  handoffWork(input: {
    claimToken: string;
    reason: string;
    toAgentId?: string;
    toAgentRoleScopes?: string[];
    evidenceRefs?: string[];
    leaseMs?: number;
    now?: Date;
  }): { receipt: GoalHandoffReceipt; claim?: GoalWorkClaim } | undefined {
    const now = input.now ?? new Date();
    return this.driver.transaction(() => {
      const row = this.driver.prepare(
        'SELECT * FROM goal_work_claims WHERE claim_token = ? AND lease_expires_at > ?',
      ).get(input.claimToken, now.toISOString());
      if (!row) return undefined;
      const evidenceRefs = unique(input.evidenceRefs ?? []);
      const goal = this.readSnapshot(String(row.goal_id));
      const workItem = goal?.workItems.find(item => item.id === String(row.work_item_id));
      const toAgentRoleScopes = unique(input.toAgentRoleScopes ?? []);
      if (
        input.toAgentId
        && (
          workItem?.excludedAgentIds?.includes(input.toAgentId)
          || ((workItem?.roleScopes?.length ?? 0) > 0
            && !workItem!.roleScopes!.some(scope => toAgentRoleScopes.includes(scope)))
        )
      ) {
        return undefined;
      }
      const inserted = this.driver.prepare(`
        INSERT INTO goal_handoffs (
          goal_id, work_item_id, from_agent_id, to_agent_id, reason, evidence_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.goal_id,
        row.work_item_id,
        row.agent_id,
        input.toAgentId ?? null,
        input.reason.trim() || 'handoff',
        JSON.stringify(evidenceRefs),
        now.toISOString(),
      );
      this.driver.prepare('DELETE FROM goal_work_claims WHERE claim_token = ?').run(input.claimToken);
      let claim: GoalWorkClaim | undefined;
      if (input.toAgentId) {
        claim = {
          goalId: String(row.goal_id),
          workItemId: String(row.work_item_id),
          agentId: input.toAgentId,
          claimToken: `goal-claim:${createId()}`,
          roleScopes: toAgentRoleScopes,
          claimedAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 15 * 60_000)).toISOString(),
          updatedAt: now.toISOString(),
        };
        this.driver.prepare(`
          INSERT INTO goal_work_claims (
            goal_id, work_item_id, agent_id, claim_token, role_scopes_json,
            claimed_at, lease_expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          claim.goalId, claim.workItemId, claim.agentId, claim.claimToken,
          JSON.stringify(claim.roleScopes),
          claim.claimedAt, claim.leaseExpiresAt, claim.updatedAt,
        );
      }
      const receipt: GoalHandoffReceipt = {
        id: Number(inserted.lastInsertRowid),
        goalId: String(row.goal_id),
        workItemId: String(row.work_item_id),
        fromAgentId: String(row.agent_id),
        ...(input.toAgentId ? { toAgentId: input.toAgentId } : {}),
        reason: input.reason.trim() || 'handoff',
        evidenceRefs,
        at: now.toISOString(),
      };
      this.insertEvent(receipt.goalId, 'work_handed_off', receipt.at, undefined, {
        workItemId: receipt.workItemId,
        fromAgentId: receipt.fromAgentId,
        ...(receipt.toAgentId ? { toAgentId: receipt.toAgentId } : {}),
      });
      return { receipt, ...(claim ? { claim } : {}) };
    });
  }

  listWorkClaims(goalId: string, options: { includeExpired?: boolean; now?: Date } = {}): GoalWorkClaim[] {
    const rows = this.driver.prepare(`
      SELECT * FROM goal_work_claims WHERE goal_id = ?
      ${options.includeExpired ? '' : 'AND lease_expires_at > ?'}
      ORDER BY claimed_at ASC
    `).all(...(options.includeExpired ? [goalId] : [goalId, (options.now ?? new Date()).toISOString()]));
    return rows.map(mapWorkClaim);
  }

  listHandoffs(goalId: string, limit = 100): GoalHandoffReceipt[] {
    return this.driver.prepare(`
      SELECT * FROM goal_handoffs WHERE goal_id = ? ORDER BY handoff_id DESC LIMIT ?
    `).all(goalId, Math.max(1, Math.min(limit, 500))).reverse().map(row => ({
      id: Number(row.handoff_id),
      goalId: String(row.goal_id),
      workItemId: String(row.work_item_id),
      fromAgentId: String(row.from_agent_id),
      ...(typeof row.to_agent_id === 'string' ? { toAgentId: row.to_agent_id } : {}),
      reason: String(row.reason),
      evidenceRefs: parseStringArray(row.evidence_refs_json),
      at: String(row.created_at),
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
        this.driver.prepare('DELETE FROM goal_work_claims WHERE goal_id = ?').run(goalId);
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
      if (goal.status === 'complete' || goal.status === 'cancelled' || goal.status === 'blocked') {
        this.driver.prepare('DELETE FROM goal_work_claims WHERE goal_id = ?').run(goalId);
      }
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
        this.driver.prepare('DELETE FROM goal_work_claims WHERE goal_id = ?').run(goalId);
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
      if (next.status === 'complete' || next.status === 'cancelled' || next.status === 'blocked') {
        this.driver.prepare('DELETE FROM goal_work_claims WHERE goal_id = ?').run(goalId);
      }
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

    CREATE TABLE IF NOT EXISTS goal_continuation (
      goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      execution_profile_json TEXT,
      min_interval_seconds INTEGER NOT NULL,
      max_interval_seconds INTEGER NOT NULL,
      current_interval_seconds INTEGER NOT NULL,
      next_wake_at TEXT,
      last_wake_at TEXT,
      last_outcome TEXT,
      consecutive_no_change INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_goal_continuation_wake
      ON goal_continuation(mode, next_wake_at);

    CREATE TABLE IF NOT EXISTS goal_work_claims (
      goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      role_scopes_json TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(goal_id, work_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_goal_work_claims_lease
      ON goal_work_claims(goal_id, lease_expires_at);

    CREATE TABLE IF NOT EXISTS goal_handoffs (
      handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      reason TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_goal_handoffs_goal
      ON goal_handoffs(goal_id, handoff_id);
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

function mapContinuation(row: Record<string, unknown>): GoalContinuationState {
  const parsedProfile = typeof row.execution_profile_json === 'string'
    ? parseObject(row.execution_profile_json)
    : undefined;
  const executionProfile = parsedProfile
    && (parsedProfile.kind === 'config' || parsedProfile.kind === 'agent')
    && typeof parsedProfile.name === 'string'
    ? { kind: parsedProfile.kind, name: parsedProfile.name } as GoalContinuationProfileRef
    : undefined;
  return {
    goalId: String(row.goal_id),
    mode: String(row.mode) as GoalContinuationMode,
    ...(executionProfile ? { executionProfile } : {}),
    minIntervalSeconds: Number(row.min_interval_seconds),
    maxIntervalSeconds: Number(row.max_interval_seconds),
    currentIntervalSeconds: Number(row.current_interval_seconds),
    ...(typeof row.next_wake_at === 'string' ? { nextWakeAt: row.next_wake_at } : {}),
    ...(typeof row.last_wake_at === 'string' ? { lastWakeAt: row.last_wake_at } : {}),
    ...(typeof row.last_outcome === 'string' ? { lastOutcome: row.last_outcome } : {}),
    consecutiveNoChange: Number(row.consecutive_no_change ?? 0),
    ...(typeof row.lease_owner === 'string' ? { leaseOwner: row.lease_owner } : {}),
    ...(typeof row.lease_expires_at === 'string' ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
  };
}

function clampSeconds(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isFuture(value: string | undefined, now: Date): boolean {
  return Boolean(value && Date.parse(value) > now.getTime());
}

function mapWorkClaim(row: Record<string, unknown>): GoalWorkClaim {
  return {
    goalId: String(row.goal_id),
    workItemId: String(row.work_item_id),
    agentId: String(row.agent_id),
    claimToken: String(row.claim_token),
    roleScopes: parseStringArray(row.role_scopes_json),
    claimedAt: String(row.claimed_at),
    leaseExpiresAt: String(row.lease_expires_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function compareGoalWorkItems(a: Goal['workItems'][number], b: Goal['workItems'][number]): number {
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt);
}
