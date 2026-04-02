import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActoviqBackgroundTaskRecord } from '../types.js';
import { createId } from '../runtime/helpers.js';

export class BackgroundTaskStore {
  constructor(private readonly rootDirectory: string) {}

  async create(task: Omit<ActoviqBackgroundTaskRecord, 'id'>): Promise<ActoviqBackgroundTaskRecord> {
    await this.ensureReady();
    const record: ActoviqBackgroundTaskRecord = {
      ...task,
      id: createId(),
    };
    await this.save(record);
    return record;
  }

  async save(task: ActoviqBackgroundTaskRecord): Promise<void> {
    await this.ensureReady();
    await writeJsonAtomic(this.taskPath(task.id), task);
  }

  async load(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined> {
    await this.ensureReady();
    try {
      const raw = await readFile(this.taskPath(taskId), 'utf8');
      return JSON.parse(raw) as ActoviqBackgroundTaskRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<ActoviqBackgroundTaskRecord[]> {
    await this.ensureReady();
    const files = await readdir(this.tasksDirectory());
    const tasks: ActoviqBackgroundTaskRecord[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = await readFile(path.join(this.tasksDirectory(), file), 'utf8');
      tasks.push(JSON.parse(raw) as ActoviqBackgroundTaskRecord);
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
    return path.join(this.rootDirectory, 'tasks');
  }

  taskPath(taskId: string): string {
    return path.join(this.tasksDirectory(), `${taskId}.json`);
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${createId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}
