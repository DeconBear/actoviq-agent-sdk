import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { HadamardBackgroundTaskRecord } from '../types.js';
import { createId } from '../runtime/helpers.js';
import { joinUnderStorageRoot, safeStorageFileName } from './pathSafety.js';
import { writeJsonAtomic } from './atomicJsonWrite.js';

const TASK_LOCK_TIMEOUT_MS = 5_000;
const TASK_LOCK_STALE_MS = 30_000;
const TASK_LOCK_RETRY_MS = 10;

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export class BackgroundTaskStore {
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDirectory: string) {}

  async create(task: Omit<HadamardBackgroundTaskRecord, 'id'>): Promise<HadamardBackgroundTaskRecord> {
    await this.ensureReady();
    const record: HadamardBackgroundTaskRecord = {
      ...task,
      id: createId(),
    };
    await this.save(record);
    return record;
  }

  async save(task: HadamardBackgroundTaskRecord): Promise<void> {
    await this.enqueue(task.id, () =>
      this.withTaskLock(task.id, () => writeJsonAtomic(this.taskPath(task.id), task)),
    );
  }

  async mutate(
    taskId: string,
    updater: (
      current: HadamardBackgroundTaskRecord,
    ) => HadamardBackgroundTaskRecord,
  ): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.enqueue(taskId, () =>
      this.withTaskLock(taskId, async () => {
        const current = await this.load(taskId);
        if (!current) {
          return undefined;
        }
        const next = updater(current);
        if (next !== current) {
          await writeJsonAtomic(this.taskPath(taskId), next);
        }
        return next;
      }),
    );
  }

  async load(taskId: string): Promise<HadamardBackgroundTaskRecord | undefined> {
    await this.ensureReady();
    try {
      const raw = await readFile(this.taskPath(taskId), 'utf8');
      return JSON.parse(raw) as HadamardBackgroundTaskRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<HadamardBackgroundTaskRecord[]> {
    await this.ensureReady();
    const files = await readdir(this.tasksDirectory());
    const tasks: HadamardBackgroundTaskRecord[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = await readFile(path.join(this.tasksDirectory(), file), 'utf8');
      tasks.push(JSON.parse(raw) as HadamardBackgroundTaskRecord);
    }

    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(taskId: string): Promise<void> {
    await this.ensureReady();
    await rm(this.taskPath(taskId), { force: true });
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.tasksDirectory(), { recursive: true });
  }

  private tasksDirectory(): string {
    return joinUnderStorageRoot(this.rootDirectory, 'tasks');
  }

  taskPath(taskId: string): string {
    return joinUnderStorageRoot(
      this.tasksDirectory(),
      safeStorageFileName('taskId', taskId, 'json'),
    );
  }

  private async enqueue<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(taskId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(taskId, settled);
    try {
      return await run;
    } finally {
      if (this.mutationQueues.get(taskId) === settled) {
        this.mutationQueues.delete(taskId);
      }
    }
  }

  private async withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    const lockPath = `${this.taskPath(taskId)}.lock`;
    const deadline = Date.now() + TASK_LOCK_TIMEOUT_MS;
    while (true) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, 'wx');
        try {
          return await action();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'EEXIST') {
          throw error;
        }
        await this.removeStaleLock(lockPath);
        if (Date.now() >= deadline) {
          throw new Error(
            `Background task ${taskId} could not acquire its write lock within ${TASK_LOCK_TIMEOUT_MS}ms.`,
          );
        }
        await delay(TASK_LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > TASK_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
