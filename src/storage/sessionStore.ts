import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SessionNotFoundError } from '../errors.js';
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
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from './pathSafety.js';

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
    await writeJsonAtomic(filePath, session);
  }

  async load(sessionId: string): Promise<StoredSession> {
    await this.ensureReady();
    const filePath = this.sessionPath(sessionId);
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as StoredSession;
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
        const session = JSON.parse(raw) as StoredSession;
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

  private toSummary(session: StoredSession): SessionSummary {
    const runtimeRaw = session.metadata.__actoviqRuntime;
    const configRaw = session.metadata.__actoviqConfigName;
    const kind = session.kind ?? (session.metadata.__actoviqKind === 'manager' ? 'manager' : undefined);
    return {
      ...(kind ? { kind } : {}),
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

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${createId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}
