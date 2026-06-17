/**
 * Global AgentPool — shared concurrency cap across workflows, teams, swarms.
 * Cap = min(16, os.cpus().length - 2). Individual components request slots;
 * excess calls queue until a slot frees.
 */
import os from 'node:os';
import type { AgentPoolSlot } from '../types.js';

const MAX_CONCURRENT = Math.max(1, Math.min(16, os.cpus().length - 2));

interface QueuedWaiter {
  resolve: (slot: AgentPoolSlot) => void;
  reject: (err: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class AgentPool {
  private active = 0;
  private nextId = 1;
  private queue: QueuedWaiter[] = [];
  private liveSlots = new Set<number>();
  private _maxConcurrent: number;

  constructor(maxConcurrent?: number) {
    this._maxConcurrent = maxConcurrent ?? MAX_CONCURRENT;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Acquire a slot. Resolves when a slot becomes available.
   * Call slot.release() when done.
   */
  async acquire(timeoutMs?: number): Promise<AgentPoolSlot> {
    if (this.active < this._maxConcurrent) {
      return this.grantSlot();
    }

    return new Promise<AgentPoolSlot>((resolve, reject) => {
      const waiter: QueuedWaiter = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error(`AgentPool acquire timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  private grantSlot(): AgentPoolSlot {
    this.active++;
    const id = this.nextId++;
    this.liveSlots.add(id);
    return { id, release: () => this.release(id) };
  }

  private release(id: number): void {
    // Idempotent: a stale or repeated release must not decrement active twice
    // (which would admit an extra waiter past maxConcurrent).
    if (!this.liveSlots.delete(id)) {
      return;
    }
    this.active = Math.max(0, this.active - 1);

    // Wake next waiter
    const next = this.queue.shift();
    if (next) {
      if (next.timeout) clearTimeout(next.timeout);
      next.resolve(this.grantSlot());
    }
  }

  /** Cancel all queued waiters. */
  drain(reason: string): void {
    while (this.queue.length > 0) {
      const w = this.queue.shift()!;
      if (w.timeout) clearTimeout(w.timeout);
      w.reject(new Error(reason));
    }
  }

  /** Release all slots (for shutdown). */
  reset(): void {
    this.drain('AgentPool reset');
    this.active = 0;
    this.liveSlots.clear();
  }
}

/** Singleton pool shared across all features. */
let _globalPool: AgentPool | null = null;

export function getGlobalAgentPool(): AgentPool {
  if (!_globalPool) {
    _globalPool = new AgentPool();
  }
  return _globalPool;
}

export function resetGlobalAgentPool(maxConcurrent?: number): void {
  _globalPool?.reset();
  _globalPool = new AgentPool(maxConcurrent);
}
