import { createId, nowIso } from '../runtime/helpers.js';
import type { RemoteJobRecord, RemoteJobRequest } from './protocol.js';
import { RemoteJobStore } from './remoteJobStore.js';

export class RemoteWorkerClient {
  constructor(private readonly store: RemoteJobStore) {}

  async submit(
    request: Omit<RemoteJobRequest, 'id' | 'createdAt'> & { idempotencyKey?: string },
  ): Promise<RemoteJobRecord> {
    return this.store.enqueue({
      id: request.idempotencyKey?.trim() || createId(),
      projectPath: request.projectPath,
      sessionId: request.sessionId,
      prompt: request.prompt,
      metadata: request.metadata,
      artifactNames: request.artifactNames,
      createdAt: nowIso(),
    });
  }

  get(jobId: string): Promise<RemoteJobRecord> {
    return this.store.get(jobId);
  }

  async wait(
    jobId: string,
    options: { signal?: AbortSignal; pollMs?: number } = {},
  ): Promise<RemoteJobRecord> {
    const pollMs = options.pollMs ?? 100;
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason;
      const job = await this.store.get(jobId);
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
}
