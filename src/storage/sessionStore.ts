import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SessionNotFoundError } from '../errors.js';
import type {
  SessionCreateOptions,
  SessionForkOptions,
  SessionSummary,
  StoredSession,
} from '../types.js';
import { createId, deepClone, nowIso, truncateText } from '../runtime/helpers.js';
import { extractPreviewFromMessages } from '../runtime/messageUtils.js';

export class SessionStore {
  constructor(private readonly rootDirectory: string) {}

  async create(options: SessionCreateOptions = {}): Promise<StoredSession> {
    await this.ensureReady();
    const createdAt = nowIso();
    const session: StoredSession = {
      version: 1,
      id: createId(),
      title: options.title?.trim() || 'Untitled Session',
      titleSource: options.title?.trim() ? 'manual' : 'auto',
      model: options.model ?? 'unknown',
      systemPrompt: options.systemPrompt,
      tags: [...(options.tags ?? [])],
      metadata: { ...(options.metadata ?? {}) },
      createdAt,
      updatedAt: createdAt,
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
      const raw = await readFile(path.join(this.sessionsDirectory(), file), 'utf8');
      const session = JSON.parse(raw) as StoredSession;
      sessions.push(this.toSummary(session));
    }

    return sessions.sort((left, right) =>
      (right.lastRunAt ?? right.updatedAt).localeCompare(left.lastRunAt ?? left.updatedAt),
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.ensureReady();
    await rm(this.sessionPath(sessionId), { force: true });
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
      runs: [],
    };
    await this.save(forked);
    return forked;
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.sessionsDirectory(), { recursive: true });
  }

  private sessionsDirectory(): string {
    return path.join(this.rootDirectory, 'sessions');
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDirectory(), `${sessionId}.json`);
  }

  private toSummary(session: StoredSession): SessionSummary {
    return {
      id: session.id,
      title: session.title,
      titleSource: session.titleSource,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastRunAt: session.lastRunAt,
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
