import type { RemoteJobRecord } from './protocol.js';
import { RemoteJobStore } from './remoteJobStore.js';

export interface LocalWorkerServerOptions {
  workerId: string;
  store: RemoteJobStore;
  execute: (job: RemoteJobRecord, signal: AbortSignal) => Promise<NonNullable<RemoteJobRecord['result']>>;
  leaseMs?: number;
}

export class LocalWorkerServer {
  private readonly leaseMs: number;

  constructor(private readonly options: LocalWorkerServerOptions) {
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async runOnce(signal?: AbortSignal): Promise<RemoteJobRecord | undefined> {
    const leased = await this.options.store.lease(this.options.workerId, this.leaseMs);
    if (!leased) return undefined;
    await this.options.store.start(leased.id, this.options.workerId, leased.leaseToken!);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const heartbeat = setInterval(() => {
      void this.options.store.heartbeat(
        leased.id,
        this.options.workerId,
        leased.leaseToken!,
        this.leaseMs,
      ).catch(() => controller.abort());
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const result = await this.options.execute(leased, controller.signal);
      return await this.options.store.complete(
        leased.id,
        this.options.workerId,
        leased.leaseToken!,
        result,
      );
    } catch (error) {
      return await this.options.store.fail(
        leased.id,
        this.options.workerId,
        leased.leaseToken!,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
    }
  }
}
