import type { SessionManagerConfig, SessionStatus } from '../types.js';
import type { SessionStore } from '../storage/sessionStore.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_CONCURRENT_ACTIVE = 10;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class SessionManager {
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  readonly config: {
    idleTimeoutMs: number;
    maxSessions: number;
    maxConcurrentActive: number;
    cleanupIntervalMs: number;
  };

  constructor(
    private readonly store: SessionStore,
    config: SessionManagerConfig = {},
  ) {
    this.config = {
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxSessions: config.maxSessions ?? DEFAULT_MAX_SESSIONS,
      maxConcurrentActive: config.maxConcurrentActive ?? DEFAULT_MAX_CONCURRENT_ACTIVE,
      cleanupIntervalMs:
        config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    };
  }

  async touch(sessionId: string): Promise<void> {
    if (this.disposed) return;

    // Reset the idle timer only after persistence work has finished. With very
    // small idle timeouts, starting the timer first can race with the touch save.
    const existing = this.idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    await this.store.updateLastActiveAt(sessionId).catch(() => {
      /* silent */
    });

    // Enforce maxSessions: if over limit, prune oldest idle/closed sessions
    await this.enforceMaxSessions();

    if (this.disposed) return;

    const timer = setTimeout(
      () => this.onIdle(sessionId, timer),
      this.config.idleTimeoutMs,
    );
    this.idleTimers.set(sessionId, timer);
  }

  async getStats(): Promise<{ total: number; active: number; idle: number; closed: number }> {
    const summaries = await this.store.list();
    const counts = { total: summaries.length, active: 0, idle: 0, closed: 0 };
    for (const s of summaries) {
      if (s.status === 'active') counts.active++;
      else if (s.status === 'idle') counts.idle++;
      else counts.closed++;
    }
    return counts;
  }

  async prune(params: { olderThan?: string; status?: SessionStatus } = {}): Promise<number> {
    this.ensureCleanupScheduled();
    const all = await this.store.list();
    let pruned = 0;

    const cutoff = params.olderThan
      ? Date.now() - parseDurationMs(params.olderThan)
      : undefined;

    for (const s of all) {
      if (params.status && s.status !== params.status) continue;
      if (cutoff !== undefined) {
        const comparisonDate = s.lastActiveAt ?? s.lastRunAt ?? s.updatedAt;
        if (new Date(comparisonDate).getTime() > cutoff) continue;
      }
      this.clearIdleTimer(s.id);
      await this.store.delete(s.id);
      pruned++;
    }

    return pruned;
  }

  async closeIdle(): Promise<number> {
    const all = await this.store.list();
    let closed = 0;
    for (const s of all) {
      if (s.status === 'idle') {
        this.clearIdleTimer(s.id);
        await this.store.updateStatus(s.id, 'closed');
        closed++;
      }
    }
    return closed;
  }

  private async enforceMaxSessions(): Promise<void> {
    const all = await this.store.list();
    const over = all.length - this.config.maxSessions;
    if (over <= 0) return;

    // Sort by lastActiveAt ascending (oldest first), then evict idle/closed
    const sorted = all
      .filter((s) => s.status === 'idle' || s.status === 'closed')
      .sort((a, b) => {
        const aTime = new Date(a.lastActiveAt ?? a.lastRunAt ?? a.updatedAt ?? 0).getTime();
        const bTime = new Date(b.lastActiveAt ?? b.lastRunAt ?? b.updatedAt ?? 0).getTime();
        return aTime - bTime;
      });

    for (let i = 0; i < sorted.length && i < over; i++) {
      const s = sorted[i];
      if (!s) continue;
      this.clearIdleTimer(s.id);
      await this.store.delete(s.id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private async onIdle(sessionId: string, timer: ReturnType<typeof setTimeout>): Promise<void> {
    // Only process if this timer is still the active one for this session
    if (this.idleTimers.get(sessionId) !== timer) return;
    try {
      await this.store.updateStatus(sessionId, 'idle');
    } catch {
      /* session may have been deleted */
    }
    // Only clean up if timer hasn't been replaced by touch()
    if (this.idleTimers.get(sessionId) === timer) {
      this.idleTimers.delete(sessionId);
    }
  }

  private ensureCleanupScheduled(): void {
    if (this.disposed || this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.prune({ status: 'closed' });
      } catch {
        /* silent */
      }
    }, this.config.cleanupIntervalMs);
    if (typeof this.cleanupTimer === 'object') {
      (this.cleanupTimer as ReturnType<typeof setInterval>).unref?.();
    }
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }
}

function parseDurationMs(input: string): number {
  const match = input.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const value = Number(match[1]);
  switch (match[2]) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 3600 * 1000;
    case 'd': return value * 86400 * 1000;
    default: return value;
  }
}
