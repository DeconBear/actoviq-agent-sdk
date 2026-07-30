import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';
import { createId, deepClone, nowIso } from '../runtime/helpers.js';
import type { RemoteJobRecord, RemoteJobRequest } from './protocol.js';

export class RemoteJobStore {
  private queue = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  async enqueue(request: RemoteJobRequest): Promise<RemoteJobRecord> {
    return this.serial(async () => {
      const existing = await this.loadIfExists(request.id);
      if (existing) return existing;
      const now = nowIso();
      const job: RemoteJobRecord = {
        ...deepClone(request),
        status: 'queued',
        attempts: 0,
        updatedAt: now,
      };
      await this.write(job);
      return deepClone(job);
    });
  }

  async lease(workerId: string, leaseMs: number): Promise<RemoteJobRecord | undefined> {
    return this.serial(async () => {
      const jobs = await this.list();
      const now = Date.now();
      const candidate = jobs.find(job =>
        job.status === 'queued'
        || ((job.status === 'leased' || job.status === 'running')
          && Date.parse(job.leaseExpiresAt ?? '') <= now),
      );
      if (!candidate) return undefined;
      const leased: RemoteJobRecord = {
        ...candidate,
        status: 'leased',
        workerId,
        leaseToken: createId(),
        leaseExpiresAt: new Date(now + leaseMs).toISOString(),
        attempts: candidate.attempts + 1,
        updatedAt: nowIso(),
      };
      await this.write(leased);
      return deepClone(leased);
    });
  }

  async start(jobId: string, workerId: string, leaseToken: string): Promise<RemoteJobRecord> {
    return this.updateOwned(jobId, workerId, leaseToken, job => ({
      ...job,
      status: 'running',
      updatedAt: nowIso(),
    }));
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<RemoteJobRecord> {
    return this.updateOwned(jobId, workerId, leaseToken, job => ({
      ...job,
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
      updatedAt: nowIso(),
    }));
  }

  async complete(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: NonNullable<RemoteJobRecord['result']>,
  ): Promise<RemoteJobRecord> {
    return this.updateOwned(jobId, workerId, leaseToken, job => ({
      ...job,
      status: 'completed',
      result: deepClone(result),
      leaseExpiresAt: undefined,
      updatedAt: nowIso(),
    }));
  }

  async fail(
    jobId: string,
    workerId: string,
    leaseToken: string,
    error: string,
  ): Promise<RemoteJobRecord> {
    return this.updateOwned(jobId, workerId, leaseToken, job => ({
      ...job,
      status: 'failed',
      error,
      leaseExpiresAt: undefined,
      updatedAt: nowIso(),
    }));
  }

  async get(jobId: string): Promise<RemoteJobRecord> {
    const job = await this.loadIfExists(jobId);
    if (!job) throw new Error(`Remote job not found: ${jobId}`);
    return job;
  }

  async list(): Promise<RemoteJobRecord[]> {
    await mkdir(this.rootDirectory, { recursive: true });
    const files = await readdir(this.rootDirectory);
    const jobs = await Promise.all(files
      .filter(file => file.endsWith('.json'))
      .map(async file => JSON.parse(
        await readFile(path.join(this.rootDirectory, file), 'utf8'),
      ) as RemoteJobRecord));
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async updateOwned(
    jobId: string,
    workerId: string,
    leaseToken: string,
    mutation: (job: RemoteJobRecord) => RemoteJobRecord,
  ): Promise<RemoteJobRecord> {
    return this.serial(async () => {
      const job = await this.get(jobId);
      if (job.workerId !== workerId || job.leaseToken !== leaseToken) {
        throw new Error(`Remote job lease ownership mismatch: ${jobId}`);
      }
      if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= Date.now()) {
        throw new Error(`Remote job lease expired: ${jobId}`);
      }
      const next = mutation(job);
      await this.write(next);
      return deepClone(next);
    });
  }

  private async loadIfExists(jobId: string): Promise<RemoteJobRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath(jobId), 'utf8')) as RemoteJobRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(job: RemoteJobRecord): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await writeJsonAtomic(this.filePath(job.id), job);
  }

  private filePath(jobId: string): string {
    assertSafeStorageSegment('jobId', jobId);
    return path.join(this.rootDirectory, `${jobId}.json`);
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.withFileLock(action);
    } finally {
      release();
    }
  }

  private async withFileLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDirectory, { recursive: true });
    const lockPath = path.join(this.rootDirectory, '.remote-job-store.lock');
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = await stat(lockPath)
          .then(value => Date.now() - value.mtimeMs)
          .catch(() => 0);
        if (age > 30_000) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the remote job store lock.');
        }
        await delay(10);
      }
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
