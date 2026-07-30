import { createHash, randomUUID } from 'node:crypto';
import { realpath as realpathCallback } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';
import type {
  CheckpointPreview,
  CheckpointRestoreConflict,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  FileChangeRecord,
  FileCheckpoint,
  FileCheckpointEntry,
  FileCheckpointStatus,
} from './types.js';

/** Prefer native realpath so Windows 8.3 short names (RUNNER~1) canonicalize. */
const realpathNative = promisify(realpathCallback.native);
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface FileCheckpointServiceOptions {
  storageRoot: string;
  workspaceRoot: string;
  maxFileBytes?: number;
  restoreConversation?: (sessionId: string, checkpointId: string) => Promise<void>;
  now?: () => string;
}

export class FileCheckpointService {
  private readonly storageRoot: string;
  private readonly workspaceRoot: string;
  private readonly maxFileBytes: number;
  private readonly now: () => string;
  private readonly restoreConversation?: FileCheckpointServiceOptions['restoreConversation'];
  private readonly turnCheckpoints = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileCheckpointServiceOptions) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.restoreConversation = options.restoreConversation;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async beginTurn(input: {
    sessionId: string;
    turnId: string;
    label?: string;
    conversationCheckpointId?: string;
  }): Promise<FileCheckpoint> {
    return this.serial(() => this.beginTurnUnlocked(input));
  }

  async recordChange(change: FileChangeRecord): Promise<FileCheckpoint> {
    return this.serial(async () => {
      const checkpointId = this.turnCheckpoints.get(change.turnId);
      const checkpoint = checkpointId
        ? await this.load(change.sessionId, checkpointId)
        : await this.beginTurnUnlocked({ sessionId: change.sessionId, turnId: change.turnId });
      const safePath = await this.assertWorkspacePath(change.filePath);
      const relativePath = path.relative(this.workspaceRoot, safePath);
      const entry = await this.createEntry(relativePath, change.before, change.after);
      const existingIndex = checkpoint.entries.findIndex(item => item.path === relativePath);
      if (existingIndex >= 0) {
        const existing = checkpoint.entries[existingIndex]!;
        checkpoint.entries[existingIndex] = await this.createEntry(
          relativePath,
          existing.beforeBlob ? await this.readBlob(existing.beforeBlob) : existing.beforeExists ? null : null,
          change.after,
          existing,
        );
      } else {
        checkpoint.entries.push(entry);
      }
      checkpoint.entries.sort((left, right) => left.path.localeCompare(right.path));
      checkpoint.updatedAt = this.now();
      checkpoint.revision += 1;
      await this.persist(checkpoint);
      return structuredClone(checkpoint);
    });
  }

  async sealTurn(
    sessionId: string,
    turnId: string,
    status: FileCheckpointStatus,
  ): Promise<FileCheckpoint | null> {
    return this.serial(async () => {
      const checkpointId = this.turnCheckpoints.get(turnId);
      if (!checkpointId) return null;
      const checkpoint = await this.load(sessionId, checkpointId);
      checkpoint.status = status;
      checkpoint.updatedAt = this.now();
      checkpoint.revision += 1;
      await this.persist(checkpoint);
      this.turnCheckpoints.delete(turnId);
      return structuredClone(checkpoint);
    });
  }

  async list(sessionId: string): Promise<FileCheckpoint[]> {
    const dir = this.sessionDirectory(sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const checkpoints: FileCheckpoint[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(dir, file), 'utf8');
        checkpoints.push(JSON.parse(raw) as FileCheckpoint);
      } catch {
        // A corrupt manifest is isolated; other checkpoints remain usable.
      }
    }
    return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async load(sessionId: string, checkpointId: string): Promise<FileCheckpoint> {
    const raw = await readFile(this.manifestPath(sessionId, checkpointId), 'utf8');
    const parsed = JSON.parse(raw) as FileCheckpoint;
    if (parsed.sessionId !== sessionId || parsed.id !== checkpointId) {
      throw new Error('Checkpoint manifest identity mismatch.');
    }
    return parsed;
  }

  async preview(sessionId: string, checkpointId: string): Promise<CheckpointPreview> {
    const checkpoint = await this.load(sessionId, checkpointId);
    const conflicts = await this.findConflicts(checkpoint);
    return {
      checkpoint,
      conflicts,
      files: checkpoint.entries.map(entry => ({
        path: entry.path,
        action: !entry.recoverable
          ? 'unrecoverable'
          : !entry.beforeExists && entry.afterExists
            ? 'delete'
            : entry.beforeHash === entry.afterHash
              ? 'unchanged'
              : 'restore',
        binary: entry.binary,
        sizeBefore: entry.sizeBefore,
        sizeAfter: entry.sizeAfter,
      })),
    };
  }

  async restore(input: {
    sessionId: string;
    checkpointId: string;
    mode: CheckpointRestoreMode;
    force?: boolean;
  }): Promise<CheckpointRestoreResult> {
    return this.serial(async () => {
      const checkpoint = await this.load(input.sessionId, input.checkpointId);
      const restoreFiles = input.mode === 'files' || input.mode === 'both';
      const restoreConversation = input.mode === 'conversation' || input.mode === 'both';
      const conflicts = restoreFiles ? await this.findConflicts(checkpoint) : [];
      if (conflicts.length > 0 && !input.force) {
        return {
          checkpointId: checkpoint.id,
          mode: input.mode,
          restoredFiles: [],
          conversationRestored: false,
          conflicts,
        };
      }

      const restoredFiles: string[] = [];
      if (restoreFiles) {
        for (const entry of checkpoint.entries) {
          if (!entry.recoverable) continue;
          const target = await this.assertWorkspacePath(path.join(this.workspaceRoot, entry.path), false);
          if (!entry.beforeExists) {
            await rm(target, { force: true });
          } else {
            if (!entry.beforeBlob) throw new Error(`Checkpoint blob missing for ${entry.path}.`);
            const content = await this.readBlob(entry.beforeBlob);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
          }
          restoredFiles.push(entry.path);
        }
      }

      let conversationRestored = false;
      if (restoreConversation) {
        if (!checkpoint.conversationCheckpointId || !this.restoreConversation) {
          throw new Error('This checkpoint does not include a restorable conversation snapshot.');
        }
        await this.restoreConversation(checkpoint.sessionId, checkpoint.conversationCheckpointId);
        conversationRestored = true;
      }
      return {
        checkpointId: checkpoint.id,
        mode: input.mode,
        restoredFiles,
        conversationRestored,
        conflicts: [],
      };
    });
  }

  private async findConflicts(checkpoint: FileCheckpoint): Promise<CheckpointRestoreConflict[]> {
    const conflicts: CheckpointRestoreConflict[] = [];
    for (const entry of checkpoint.entries) {
      if (!entry.recoverable) {
        conflicts.push({
          path: entry.path,
          reason: 'unrecoverable-entry',
          message: entry.omittedReason ?? 'Checkpoint content was not retained.',
        });
        continue;
      }
      let target: string;
      try {
        target = await this.assertWorkspacePath(path.join(this.workspaceRoot, entry.path), false);
      } catch (error) {
        conflicts.push({
          path: entry.path,
          reason: 'path-escape',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const actualHash = current ? hash(current) : undefined;
      if (actualHash !== entry.afterHash) {
        conflicts.push({
          path: entry.path,
          expectedHash: entry.afterHash,
          actualHash,
          reason: 'modified-after-checkpoint',
          message: `${entry.path} changed after this checkpoint was recorded.`,
        });
      }
    }
    return conflicts;
  }

  private async createEntry(
    relativePath: string,
    before: Buffer | null,
    after: Buffer | null,
    original?: FileCheckpointEntry,
  ): Promise<FileCheckpointEntry> {
    const initialBefore = original?.beforeExists
      ? before
      : original?.beforeExists === false
        ? null
        : before;
    const beforeTooLarge = Boolean(initialBefore && initialBefore.length > this.maxFileBytes);
    const afterTooLarge = Boolean(after && after.length > this.maxFileBytes);
    const recoverable = original?.recoverable !== false && !beforeTooLarge && !afterTooLarge;
    const beforeBlob = recoverable && initialBefore ? await this.writeBlob(initialBefore) : undefined;
    const afterBlob = recoverable && after ? await this.writeBlob(after) : undefined;
    return {
      path: relativePath,
      beforeExists: original?.beforeExists ?? initialBefore !== null,
      afterExists: after !== null,
      beforeHash: original?.beforeHash ?? (initialBefore ? hash(initialBefore) : undefined),
      afterHash: after ? hash(after) : undefined,
      beforeBlob: original?.beforeBlob ?? beforeBlob,
      afterBlob,
      binary: original?.binary ?? (isBinary(initialBefore) || isBinary(after)),
      sizeBefore: original?.sizeBefore ?? initialBefore?.length ?? 0,
      sizeAfter: after?.length ?? 0,
      recoverable,
      ...(!recoverable
        ? { omittedReason: `File exceeds checkpoint limit (${this.maxFileBytes} bytes).` }
        : {}),
    };
  }

  private async writeBlob(content: Buffer): Promise<string> {
    const digest = hash(content);
    const blobPath = path.join(this.storageRoot, 'blobs', digest);
    await mkdir(path.dirname(blobPath), { recursive: true });
    try {
      await stat(blobPath);
    } catch {
      await writeFile(blobPath, content, { flag: 'wx' }).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
    return digest;
  }

  private readBlob(digest: string): Promise<Buffer> {
    return readFile(path.join(this.storageRoot, 'blobs', assertSafeStorageSegment('blob', digest)));
  }

  private async persist(checkpoint: FileCheckpoint): Promise<void> {
    const manifest = this.manifestPath(checkpoint.sessionId, checkpoint.id);
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeJsonAtomic(manifest, checkpoint);
  }

  private async beginTurnUnlocked(input: {
    sessionId: string;
    turnId: string;
    label?: string;
    conversationCheckpointId?: string;
  }): Promise<FileCheckpoint> {
    const existingId = this.turnCheckpoints.get(input.turnId);
    if (existingId) return this.load(input.sessionId, existingId);
    const timestamp = this.now();
    const checkpoint: FileCheckpoint = {
      version: 1,
      revision: 0,
      id: randomUUID(),
      sessionId: assertSafeStorageSegment('sessionId', input.sessionId),
      turnId: assertSafeStorageSegment('turnId', input.turnId),
      label: input.label?.trim() || `Before turn ${input.turnId}`,
      workspaceRoot: this.workspaceRoot,
      ...(input.conversationCheckpointId
        ? { conversationCheckpointId: assertSafeStorageSegment('checkpointId', input.conversationCheckpointId) }
        : {}),
      status: 'open',
      entries: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.persist(checkpoint);
    this.turnCheckpoints.set(input.turnId, checkpoint.id);
    return structuredClone(checkpoint);
  }

  private sessionDirectory(sessionId: string): string {
    return path.join(this.storageRoot, 'sessions', assertSafeStorageSegment('sessionId', sessionId));
  }

  private manifestPath(sessionId: string, checkpointId: string): string {
    return path.join(
      this.sessionDirectory(sessionId),
      `${assertSafeStorageSegment('checkpointId', checkpointId)}.json`,
    );
  }

  private async assertWorkspacePath(filePath: string, requireExisting = true): Promise<string> {
    const target = path.resolve(filePath);
    const relative = path.relative(this.workspaceRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Checkpoint path escapes workspace: ${target}`);
    }
    const rootReal = await realpathNative(this.workspaceRoot).catch(() => path.resolve(this.workspaceRoot));
    // recordChange often receives buffers for files that are not on disk yet, so
    // walk to the nearest existing ancestor before realpath (Windows 8.3 safe).
    const probe = requireExisting ? target : path.dirname(target);
    const probeExisting = await nearestExistingPath(probe);
    const probeReal = await realpathNative(probeExisting).catch(() => path.resolve(probeExisting));
    const realRelative = path.relative(rootReal, probeReal);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`Checkpoint path resolves outside workspace: ${target}`);
    }
    return target;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function nearestExistingPath(target: string): Promise<string> {
  return (async () => {
    let current = path.resolve(target);
    while (true) {
      try {
        await realpathNative(current);
        return current;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  })();
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isBinary(content: Buffer | null): boolean {
  return Boolean(content?.subarray(0, 8_192).includes(0));
}
