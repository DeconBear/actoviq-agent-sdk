import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  SessionConflictError,
  SessionDataError,
  SessionNotFoundError,
} from '../errors.js';
import type {
  SessionCheckpoint,
  SessionCheckpointSummary,
  SessionCreateOptions,
  SessionForkOptions,
  SessionStatus,
  SessionSummary,
  StoredSession,
} from '../types.js';
import { createId, deepClone, nowIso, truncateText } from '../runtime/helpers.js';
import { extractPreviewFromMessages } from '../runtime/messageUtils.js';
import { writeJsonAtomic } from './atomicJsonWrite.js';
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from './pathSafety.js';

const SESSION_LOCK_TIMEOUT_MS = 5_000;
const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_RETRY_MS = 10;

export class SessionStore {
  constructor(private readonly rootDirectory: string) {}

  async create(options: SessionCreateOptions = {}): Promise<StoredSession> {
    await this.ensureReady();
    if (options.id) {
      try {
        await this.load(options.id);
        throw new Error(`Session already exists: ${options.id}`);
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) {
          throw error;
        }
      }
    }
    const createdAt = nowIso();
    const session: StoredSession = {
      version: 1,
      revision: 0,
      id: options.id ?? createId(),
      title: options.title?.trim() || 'Untitled Session',
      titleSource: options.title?.trim() ? 'manual' : 'auto',
      model: options.model ?? 'unknown',
      systemPrompt: options.systemPrompt,
      tags: [...(options.tags ?? [])],
      metadata: { ...(options.metadata ?? {}) },
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      status: 'active',
      messages: deepClone(options.initialMessages ?? []),
      runs: [],
    };
    await this.save(session);
    return session;
  }

  async save(session: StoredSession): Promise<void> {
    await this.ensureReady();
    const filePath = this.sessionPath(session.id);
    await this.withSessionLock(session.id, async () => {
      const current = await this.loadIfExists(session.id);
      const expectedRevision = normalizeRevision(session.revision, session.id);
      const actualRevision = current?.revision ?? 0;

      if (current && actualRevision !== expectedRevision) {
        throw new SessionConflictError(session.id, expectedRevision, actualRevision);
      }
      if (!current && expectedRevision !== 0) {
        throw new SessionConflictError(session.id, expectedRevision, 0);
      }

      const nextRevision = actualRevision + 1;
      const next: StoredSession = {
        ...deepClone(session),
        revision: nextRevision,
      };
      validateStoredSession(next, session.id);
      await writeJsonAtomic(filePath, next);
      session.revision = nextRevision;
    });
  }

  async load(sessionId: string): Promise<StoredSession> {
    await this.ensureReady();
    const filePath = this.sessionPath(sessionId);
    try {
      const raw = await readFile(filePath, 'utf8');
      return parseStoredSession(raw, sessionId);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  }

  async list(): Promise<SessionSummary[]> {
    await this.ensureReady();
    const files = await readdir(this.sessionsDirectory());
    const sessions: SessionSummary[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(this.sessionsDirectory(), file);
      try {
        const raw = await readFile(filePath, 'utf8');
        const sessionId = file.slice(0, -'.json'.length);
        const session = parseStoredSession(raw, sessionId);
        sessions.push(this.toSummary(session));
      } catch (error) {
        // A single corrupt or unreadable session file should not hide the
        // rest of the user's session history. Warn and continue. This
        // matters in real-world failure modes: power loss mid-write, disk
        // full, concurrent writes from another process, or a manually
        // edited file with malformed JSON. Without isolation, one bad
        // file makes `list()` throw and the user sees an empty session
        // list — losing access to N-1 perfectly good sessions.
        console.warn(
          `[SessionStore] Skipping unreadable session ${file}: ${(error as Error).message}`,
        );
      }
    }

    return sessions.sort((left, right) =>
      (right.lastRunAt ?? right.updatedAt).localeCompare(left.lastRunAt ?? left.updatedAt),
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.ensureReady();
    await rm(this.sessionPath(sessionId), { force: true });
  }

  async updateStatus(sessionId: string, status: import('../types.js').SessionStatus): Promise<void> {
    await this.ensureReady();
    const session = await this.load(sessionId);
    session.status = status;
    session.updatedAt = nowIso();
    await this.save(session);
  }

  async updateLastActiveAt(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.ensureReady();
    const session = await this.load(sessionId);
    session.lastActiveAt = nowIso();
    if (status && session.status !== 'closed') {
      session.status = status;
    }
    await this.save(session);
  }

  async fork(sessionId: string, options: SessionForkOptions = {}): Promise<StoredSession> {
    const original = await this.load(sessionId);
    const createdAt = nowIso();
    const forked: StoredSession = {
      ...deepClone(original),
      revision: 0,
      id: createId(),
      title: options.title?.trim() || `${original.title} Copy`,
      titleSource: options.title?.trim() ? 'manual' : 'auto',
      tags: [...(options.tags ?? original.tags)],
      metadata: {
        ...original.metadata,
        ...(options.metadata ?? {}),
      },
      createdAt,
      updatedAt: createdAt,
      lastRunAt: undefined,
      lastActiveAt: createdAt,
      status: 'active',
      runs: [],
    };
    await this.save(forked);
    return forked;
  }

  async saveCheckpoint(sessionId: string, label: string): Promise<SessionCheckpoint> {
    const session = await this.load(sessionId);
    const checkpointId = createId();
    const checkpoint: SessionCheckpoint = {
      id: checkpointId,
      label,
      sessionId,
      createdAt: nowIso(),
      snapshot: deepClone(session),
    };
    await this.ensureReady();
    const dir = this.checkpointsDirectory(sessionId);
    await mkdir(dir, { recursive: true });
    const filePath = joinUnderStorageRoot(
      dir,
      safeStorageFileName('checkpointId', checkpointId, 'json'),
    );
    await writeJsonAtomic(filePath, checkpoint);
    return checkpoint;
  }

  async loadCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint> {
    const filePath = path.join(
      this.checkpointsDirectory(sessionId),
      safeStorageFileName('checkpointId', checkpointId, 'json'),
    );
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as SessionCheckpoint;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        throw new SessionNotFoundError(`checkpoint ${checkpointId}`);
      }
      throw error;
    }
  }

  async listCheckpoints(sessionId: string): Promise<SessionCheckpointSummary[]> {
    const dir = this.checkpointsDirectory(sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') return [];
      throw error;
    }
    const summaries: SessionCheckpointSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const raw = await readFile(filePath, 'utf8');
        const cp = JSON.parse(raw) as SessionCheckpoint;
        summaries.push({ id: cp.id, label: cp.label, createdAt: cp.createdAt });
      } catch (error) {
        console.warn(
          `[SessionStore] Skipping unreadable checkpoint ${file}: ${(error as Error).message}`,
        );
      }
    }
    return summaries.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const filePath = path.join(
      this.checkpointsDirectory(sessionId),
      safeStorageFileName('checkpointId', checkpointId, 'json'),
    );
    await rm(filePath, { force: true });
  }

  private checkpointsDirectory(sessionId: string): string {
    return joinUnderStorageRoot(
      this.sessionsDirectory(),
      '.checkpoints',
      assertSafeStorageSegment('sessionId', sessionId),
    );
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.sessionsDirectory(), { recursive: true });
  }

  private sessionsDirectory(): string {
    return joinUnderStorageRoot(this.rootDirectory, 'sessions');
  }

  private sessionPath(sessionId: string): string {
    return joinUnderStorageRoot(
      this.sessionsDirectory(),
      safeStorageFileName('sessionId', sessionId, 'json'),
    );
  }

  private async loadIfExists(sessionId: string): Promise<StoredSession | undefined> {
    try {
      const raw = await readFile(this.sessionPath(sessionId), 'utf8');
      return parseStoredSession(raw, sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${this.sessionPath(sessionId)}.lock`;
    const deadline = Date.now() + SESSION_LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    while (!handle) {
      try {
        handle = await open(lockPath, 'wx');
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'EEXIST') {
          throw error;
        }
        await this.removeStaleLock(lockPath);
        if (Date.now() >= deadline) {
          throw new SessionDataError(
            sessionId,
            `could not acquire its write lock within ${SESSION_LOCK_TIMEOUT_MS}ms`,
            { cause: error },
          );
        }
        await delay(SESSION_LOCK_RETRY_MS);
      }
    }

    try {
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > SESSION_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private toSummary(session: StoredSession): SessionSummary {
    const runtimeRaw = session.metadata.__actoviqRuntime;
    const configRaw = session.metadata.__actoviqConfigName;
    const kind = session.kind ?? (session.metadata.__actoviqKind === 'manager' ? 'manager' : undefined);
    const issueIdRaw = session.metadata.__actoviqIssueId;
    const issueNumberRaw = session.metadata.__actoviqIssueNumber;
    const issueKeyRaw = session.metadata.__actoviqIssueKey;
    const agentProfileRaw = session.metadata.__actoviqAgentProfile;
    const issueNumber = typeof issueNumberRaw === 'number'
      ? issueNumberRaw
      : typeof issueNumberRaw === 'string' && Number.isFinite(Number(issueNumberRaw))
        ? Number(issueNumberRaw)
        : undefined;
    return {
      ...(kind ? { kind } : {}),
      ...(typeof issueIdRaw === 'string' && issueIdRaw.trim() ? { issueId: issueIdRaw.trim() } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(typeof issueKeyRaw === 'string' && issueKeyRaw.trim() ? { issueKey: issueKeyRaw.trim() } : {}),
      ...(typeof agentProfileRaw === 'string' && agentProfileRaw.trim() ? { agentProfile: agentProfileRaw.trim() } : {}),
      id: session.id,
      title: session.title,
      titleSource: session.titleSource,
      model: session.model,
      runtime: typeof runtimeRaw === 'string' && runtimeRaw.trim() ? runtimeRaw.trim() : 'hadamard',
      configName: typeof configRaw === 'string' && configRaw.trim() ? configRaw.trim() : null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastRunAt: session.lastRunAt,
      lastActiveAt: session.lastActiveAt,
      status: session.status,
      tags: [...session.tags],
      preview: truncateText(extractPreviewFromMessages(session.messages), 160),
      messageCount: session.messages.length,
      runCount: session.runs.length,
    };
  }
}

function parseStoredSession(raw: string, sessionId: string): StoredSession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new SessionDataError(sessionId, 'the JSON document cannot be parsed', {
      cause: error,
    });
  }
  return validateStoredSession(value, sessionId);
}

function validateStoredSession(value: unknown, sessionId: string): StoredSession {
  if (!isRecord(value)) {
    throw new SessionDataError(sessionId, 'the root value must be an object');
  }
  if (value.version !== 1) {
    throw new SessionDataError(sessionId, `unsupported version ${String(value.version)}`);
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new SessionDataError(sessionId, 'id must be a non-empty string');
  }
  if (value.id !== sessionId) {
    throw new SessionDataError(sessionId, `stored id is "${value.id}"`);
  }
  for (const field of ['title', 'model', 'createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string') {
      throw new SessionDataError(sessionId, `${field} must be a string`);
    }
  }
  if (value.titleSource !== 'auto' && value.titleSource !== 'manual') {
    throw new SessionDataError(sessionId, 'titleSource must be "auto" or "manual"');
  }
  if (value.status !== 'active' && value.status !== 'idle' && value.status !== 'closed') {
    throw new SessionDataError(sessionId, 'status is invalid');
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    throw new SessionDataError(sessionId, 'tags must be an array of strings');
  }
  if (!isRecord(value.metadata)) {
    throw new SessionDataError(sessionId, 'metadata must be an object');
  }
  if (!Array.isArray(value.messages)) {
    throw new SessionDataError(sessionId, 'messages must be an array');
  }
  if (!Array.isArray(value.runs)) {
    throw new SessionDataError(sessionId, 'runs must be an array');
  }

  const revision = value.revision == null ? 0 : normalizeRevision(value.revision, sessionId);
  return {
    ...(value as unknown as StoredSession),
    revision,
  };
}

function normalizeRevision(value: unknown, sessionId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionDataError(sessionId, 'revision must be a non-negative safe integer');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
