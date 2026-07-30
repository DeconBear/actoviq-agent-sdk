/**
 * GoalStore - persists a Goal in a session's metadata under `__actoviqGoal`.
 *
 * The store is a thin adapter over a session-metadata port so it can run
 * against either a live `AgentSession` (which owns `mergeMetadata`) or a raw
 * `StoredSession` snapshot (used by tests and the catalog). Legacy sessions
 * stored a minimal `{ objective, status, setAt }` object; on first read we
 * normalize it into the versioned v1 contract. The legacy field is preserved
 * untouched until the next write, which replaces it with the v1 shape.
 */
import type { Goal, GoalBlockAudit, GoalBudget, GoalEvidence, GoalStatus } from './types.js';
import { GOAL_SCHEMA_VERSION } from './types.js';

/** Metadata key under which the Goal contract is persisted. */
export const GOAL_METADATA_KEY = '__actoviqGoal';

/**
 * Port to a session's metadata. `read` returns the raw persisted value;
 * `write` atomically replaces it. Implementations: `AgentSession`-backed
 * (calls `mergeMetadata`) and a plain-object test adapter.
 */
export interface GoalSessionPort {
  readGoalMetadata(): unknown;
  writeGoalMetadata(value: Goal | undefined): Promise<void>;
  updateGoalMetadata?(
    mutation: (current: unknown) => Goal | undefined,
  ): Promise<Goal | undefined>;
}

/** A `GoalSessionPort` over a live `AgentSession`-like object. */
export class AgentSessionGoalPort implements GoalSessionPort {
  constructor(
    private readonly session: {
      metadata: Record<string, unknown>;
      mergeMetadata(metadata: Record<string, unknown>): Promise<unknown>;
      mutateMetadata?(
        mutation: (metadata: Record<string, unknown>) => Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    },
  ) {}

  readGoalMetadata(): unknown {
    return this.session.metadata[GOAL_METADATA_KEY];
  }

  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    // mergeMetadata cannot delete a key; setting undefined clears it
    // functionally (readGoalMetadata treats falsy as absent) and
    // JSON.stringify drops it on save.
    await this.session.mergeMetadata({ [GOAL_METADATA_KEY]: value });
  }

  async updateGoalMetadata(
    mutation: (current: unknown) => Goal | undefined,
  ): Promise<Goal | undefined> {
    if (!this.session.mutateMetadata) {
      const next = mutation(this.readGoalMetadata());
      await this.writeGoalMetadata(next);
      return next;
    }
    let nextValue: Goal | undefined;
    await this.session.mutateMetadata(metadata => {
      nextValue = mutation(metadata[GOAL_METADATA_KEY]);
      const nextMetadata = { ...metadata };
      if (nextValue === undefined) delete nextMetadata[GOAL_METADATA_KEY];
      else nextMetadata[GOAL_METADATA_KEY] = nextValue;
      return nextMetadata;
    });
    return nextValue;
  }
}

/**
 * Minimal store port for {@link StoredSessionGoalPort}. Mirrors the slice of
 * `SessionStore` the goal store needs, so the goal module stays decoupled from
 * the storage package. The mutation receives a session-shaped object and
 * returns the next session-shaped object (matching `SessionStore.mutate`).
 */
export interface GoalStorePort {
  mutate(
    sessionId: string,
    mutation: (session: { metadata: Record<string, unknown> }) => { metadata: Record<string, unknown> },
  ): Promise<{ metadata: Record<string, unknown> }>;
}

/**
 * A `GoalSessionPort` over a persisted `StoredSession` via a store's atomic
 * `mutate`. Reads come from the latest on-disk state; writes go through the
 * session lock. Used by the runtime when only a `StoredSession` snapshot is
 * available (no live `AgentSession`).
 */
export class StoredSessionGoalPort implements GoalSessionPort {
  private cache: unknown | undefined;
  private loaded = false;

  constructor(
    private readonly store: GoalStorePort,
    private readonly sessionId: string,
    private readonly initialMetadata?: Record<string, unknown>,
  ) {}

  readGoalMetadata(): unknown {
    if (!this.loaded) {
      this.cache = this.initialMetadata?.[GOAL_METADATA_KEY];
      this.loaded = true;
    }
    return this.cache;
  }

  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    const updated = await this.store.mutate(this.sessionId, (session) => {
      const metadata = { ...session.metadata };
      if (value === undefined) {
        delete metadata[GOAL_METADATA_KEY];
      } else {
        metadata[GOAL_METADATA_KEY] = value;
      }
      return { ...session, metadata };
    });
    this.cache = updated.metadata[GOAL_METADATA_KEY];
    this.loaded = true;
  }

  async updateGoalMetadata(
    mutation: (current: unknown) => Goal | undefined,
  ): Promise<Goal | undefined> {
    let nextValue: Goal | undefined;
    const updated = await this.store.mutate(this.sessionId, (session) => {
      nextValue = mutation(session.metadata[GOAL_METADATA_KEY]);
      const metadata = { ...session.metadata };
      if (nextValue === undefined) delete metadata[GOAL_METADATA_KEY];
      else metadata[GOAL_METADATA_KEY] = nextValue;
      return { ...session, metadata };
    });
    this.cache = updated.metadata[GOAL_METADATA_KEY];
    this.loaded = true;
    return nextValue;
  }
}

interface LegacyGoal {
  objective?: unknown;
  status?: unknown;
  setAt?: unknown;
}

/** Normalize any persisted value into a v1 Goal, or return null if absent. */
export function normalizeGoal(raw: unknown, now: string): Goal | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return normalizeGoal(JSON.parse(raw), now);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  // Already a v1 (or later) contract.
  if (typeof record.version === 'number' && record.version >= GOAL_SCHEMA_VERSION) {
    return coerceV1(record, now);
  }

  // Legacy { objective, status, setAt }.
  const legacy = record as unknown as LegacyGoal;
  if (typeof legacy.objective !== 'string' || !legacy.objective.trim()) return null;
  const status = coerceLegacyStatus(legacy.status);
  const createdAt = typeof legacy.setAt === 'string' ? legacy.setAt : now;
  return {
    version: GOAL_SCHEMA_VERSION,
    objective: legacy.objective,
    status,
    evidence: [],
    blockAudit: [],
    createdAt,
    updatedAt: createdAt,
    revision: 0,
  };
}

function coerceV1(record: Record<string, unknown>, now: string): Goal | null {
  const objective = typeof record.objective === 'string' ? record.objective : '';
  if (!objective.trim()) return null;
  const status = coerceStatus(record.status) ?? 'active';
  return {
    version: GOAL_SCHEMA_VERSION,
    objective,
    status,
    ...(typeof record.completionCriteria === 'string' && record.completionCriteria.trim()
      ? { completionCriteria: record.completionCriteria }
      : {}),
    ...(isBudget(record.budget) ? { budget: record.budget } : {}),
    evidence: Array.isArray(record.evidence) ? record.evidence.filter(isEvidence) : [],
    blockAudit: Array.isArray(record.blockAudit) ? record.blockAudit.filter(isBlockAudit) : [],
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
    revision: typeof record.revision === 'number' && Number.isFinite(record.revision)
      ? Math.max(0, Math.floor(record.revision))
      : 0,
  };
}

function coerceLegacyStatus(value: unknown): GoalStatus {
  return coerceStatus(value) ?? 'active';
}

function coerceStatus(value: unknown): GoalStatus | undefined {
  if (value === 'active' || value === 'paused' || value === 'complete' || value === 'blocked') {
    return value;
  }
  return undefined;
}

function isBudget(value: unknown): value is GoalBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const hasMaxTurns = 'maxTurns' in record;
  const hasMaxToolIterations = 'maxToolIterations' in record;
  const hasMaxTokens = 'maxTokens' in record;
  if (!hasMaxTurns && !hasMaxToolIterations && !hasMaxTokens) return false;
  if (hasMaxTurns && !isNonNegativeInt(record.maxTurns)) return false;
  if (hasMaxToolIterations && !isNonNegativeInt(record.maxToolIterations)) return false;
  if (hasMaxTokens && !isNonNegativeInt(record.maxTokens)) return false;
  return true;
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

function isEvidence(value: unknown): value is GoalEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || typeof record.note !== 'string') return false;
  if ('toolCalls' in record && !isNonNegativeInt(record.toolCalls)) return false;
  if ('tokens' in record && !isNonNegativeInt(record.tokens)) return false;
  return true;
}

function isBlockAudit(value: unknown): value is GoalBlockAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || typeof record.reason !== 'string') return false;
  if ('turn' in record && !isNonNegativeInt(record.turn)) return false;
  if ('repeat' in record && !isNonNegativeInt(record.repeat)) return false;
  return true;
}

/** Read the current goal from a session port, normalizing legacy data. */
export async function readGoal(port: GoalSessionPort, now: string): Promise<Goal | null> {
  return normalizeGoal(port.readGoalMetadata(), now);
}

/** Persist a goal (or clear it) through a session port. */
export async function writeGoal(port: GoalSessionPort, goal: Goal | undefined): Promise<void> {
  await port.writeGoalMetadata(goal);
}

/**
 * Atomically normalize and update the current goal when the port is backed by
 * SessionStore. Test/legacy ports retain the read-write fallback.
 */
export async function updateGoal<T>(
  port: GoalSessionPort,
  now: string,
  mutation: (current: Goal | null) => { next: Goal | undefined; result: T },
): Promise<T> {
  let result: T | undefined;
  const apply = (raw: unknown): Goal | undefined => {
    const decision = mutation(normalizeGoal(raw, now));
    result = decision.result;
    return decision.next;
  };
  if (port.updateGoalMetadata) {
    await port.updateGoalMetadata(apply);
  } else {
    const next = apply(port.readGoalMetadata());
    await port.writeGoalMetadata(next);
  }
  return result as T;
}
