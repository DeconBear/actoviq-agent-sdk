import type {
  CronSchedule,
  ScheduledTaskContext,
  ScheduledTaskDefinition,
  ScheduledTaskRecord,
  ScheduledTaskStore,
  TaskSchedulerOptions,
} from '../types.js';
import { nowIso } from '../runtime/helpers.js';
import { nextCronTime } from './cron.js';

export class InMemoryTaskStore implements ScheduledTaskStore {
  private readonly tasks = new Map<string, ScheduledTaskRecord>();

  async save(task: ScheduledTaskRecord): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async load(id: string): Promise<ScheduledTaskRecord | undefined> {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  async list(): Promise<ScheduledTaskRecord[]> {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }
}

export class TaskScheduler {
  private readonly store: ScheduledTaskStore;
  private readonly definitions = new Map<
    string,
    ScheduledTaskDefinition & { nextRunAt: string; invocationCount: number; createdAt: string }
  >();
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultRetryDelayMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private disposed = false;

  constructor(options: TaskSchedulerOptions = {}) {
    this.store = options.store ?? new InMemoryTaskStore();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 0;
    this.defaultRetryDelayMs = options.defaultRetryDelayMs ?? 1000;
  }

  // ── Registration ────────────────────────────────────────────

  async schedule<TOutput>(
    def: ScheduledTaskDefinition<TOutput>,
  ): Promise<ScheduledTaskRecord> {
    if (this.disposed) throw new Error('Scheduler is disposed');

    const now = nowIso();
    const invocationCount = 0;
    const nextRunAt = nextCronTime(def.schedule.cron).toISOString();

    const record: ScheduledTaskRecord = {
      id: def.id,
      schedule: def.schedule.cron,
      description: def.description,
      enabled: def.enabled ?? true,
      nextRunAt,
      invocationCount,
      createdAt: now,
    };

    await this.store.save(record);

    this.definitions.set(def.id, {
      ...def,
      enabled: def.enabled ?? true,
      nextRunAt,
      invocationCount,
      createdAt: now,
    });

    return record;
  }

  async remove(id: string): Promise<void> {
    this.definitions.delete(id);
    await this.store.delete(id);
  }

  async get(id: string): Promise<ScheduledTaskRecord | undefined> {
    return this.store.load(id);
  }

  async list(): Promise<ScheduledTaskRecord[]> {
    return this.store.list();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  start(): void {
    if (this.disposed) throw new Error('Scheduler is disposed');
    if (this.running) return;
    this.running = true;
    this.scheduleNextTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    this.disposed = true;
    this.definitions.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Force immediate execution of a task (bypasses schedule). Useful for testing and manual triggers. */
  async trigger(id: string): Promise<void> {
    const def = this.definitions.get(id);
    if (!def) throw new Error(`Task "${id}" not found`);
    await this.fire(id, def);
  }

  // ── Internal tick ───────────────────────────────────────────

  private scheduleNextTick(): void {
    if (!this.running || this.disposed) return;

    const now = Date.now();
    let earliestMs = 60_000; // Default tick if nothing sooner

    for (const [id, def] of this.definitions) {
      if (!def.enabled) continue;
      const nextMs = new Date(def.nextRunAt).getTime();
      if (nextMs <= now) {
        // Due now — fire asynchronously
        this.fire(id, def);
      } else {
        const wait = nextMs - now;
        if (wait < earliestMs) earliestMs = wait;
      }
    }

    // Clamp between 500ms and 60s
    const delay = Math.max(500, Math.min(earliestMs, 60_000));
    this.timer = setTimeout(() => this.scheduleNextTick(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  private async fire(
    id: string,
    def: ScheduledTaskDefinition & { nextRunAt: string; invocationCount: number; createdAt: string },
  ): Promise<void> {
    if (!def.enabled) return;

    const startedAt = nowIso();
    const invocationCount = def.invocationCount + 1;
    def.invocationCount = invocationCount;

    const context: ScheduledTaskContext = {
      taskId: id,
      scheduledAt: startedAt,
      invocationCount,
      previousResult: undefined,
    };

    const timeoutMs = def.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = def.maxRetries ?? this.defaultMaxRetries;
    const retryDelayMs = def.retryDelayMs ?? this.defaultRetryDelayMs;

    let lastError: string | undefined;
    let success = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await withTimeout(Promise.resolve(def.task(context)), timeoutMs);
        success = true;
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          await delay(retryDelayMs);
        }
      }
    }

    const completedAt = nowIso();
    // Calculate next run time from when the task was scheduled, not completed
    const nextRunAt = nextCronTime(def.schedule.cron, new Date(startedAt)).toISOString();
    def.nextRunAt = nextRunAt;

    const record: ScheduledTaskRecord = {
      id,
      schedule: def.schedule.cron,
      description: def.description,
      enabled: def.enabled,
      lastRunAt: completedAt,
      lastResult: success ? 'success' : lastError?.includes('timed out') ? 'timeout' : 'failure',
      lastError,
      nextRunAt,
      invocationCount,
      createdAt: def.createdAt ?? nowIso(),
    };

    await this.store.save(record);
    this.definitions.set(id, def);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0 || !isFinite(ms)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
