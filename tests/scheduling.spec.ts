import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCron, nextCronTime, msUntilNextCron } from '../src/scheduling/cron.js';
import { TaskScheduler, InMemoryTaskStore } from '../src/scheduling/scheduler.js';
import type { ScheduledTaskDefinition } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────

/** Create a Date using local-time components (not UTC). */
function localDate(
  year: number,
  month: number, // 1-indexed
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const d = new Date();
  d.setFullYear(year);
  d.setMonth(month - 1);
  d.setDate(day);
  d.setHours(hour);
  d.setMinutes(minute);
  d.setSeconds(second);
  d.setMilliseconds(0);
  return d;
}

// ─── Cron Parser ──────────────────────────────────────────────

describe('parseCron', () => {
  it('parses a 5-field cron expression without throwing', () => {
    expect(() => parseCron('0 9 * * *')).not.toThrow();
    expect(() => parseCron('*/5 * * * *')).not.toThrow();
    expect(() => parseCron('0 0 1 1 *')).not.toThrow();
  });

  it('rejects expressions with wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow('5 fields');
    expect(() => parseCron('* * * * * *')).toThrow('5 fields');
    expect(() => parseCron('')).toThrow('5 fields');
  });

  it('rejects invalid numeric values', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 24 * * *')).toThrow();
    expect(() => parseCron('* * 32 * *')).toThrow();
    expect(() => parseCron('* * * 13 *')).toThrow();
  });

  it('supports day/month names', () => {
    expect(() => parseCron('0 0 * * mon')).not.toThrow();
    expect(() => parseCron('0 0 * * MON,WED,FRI')).not.toThrow();
    expect(() => parseCron('0 0 1 jan *')).not.toThrow();
    expect(() => parseCron('0 0 1 JAN,JUN,DEC *')).not.toThrow();
  });
});

describe('nextCronTime', () => {
  it('returns the next minute for * * * * *', () => {
    const from = localDate(2026, 5, 8, 12, 0);
    const next = nextCronTime('* * * * *', from);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(1);
  });

  it('returns next matching minute for specific minute', () => {
    const from = localDate(2026, 5, 8, 12, 0);
    const next = nextCronTime('30 * * * *', from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(12);
  });

  it('skips to next hour when minute is past', () => {
    const from = localDate(2026, 5, 8, 12, 45);
    const next = nextCronTime('30 * * * *', from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(13);
  });

  it('matches specific hour', () => {
    const from = localDate(2026, 5, 8, 5, 0);
    const next = nextCronTime('0 9 * * *', from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('handles step syntax */15', () => {
    const from = localDate(2026, 5, 8, 12, 1);
    const next = nextCronTime('*/15 * * * *', from);
    const min = next.getMinutes();
    expect([0, 15, 30, 45]).toContain(min);
    expect(min).toBe(15); // 12:01 -> 12:15
  });

  it('handles range syntax 1-5', () => {
    const from = localDate(2026, 5, 8, 12, 6);
    // Next occurrence: minute 1 of hour 13
    const next = nextCronTime('1-5 * * * *', from);
    expect(next.getMinutes()).toBe(1);
    expect(next.getHours()).toBe(13);
  });

  it('handles list syntax 0,30', () => {
    const from = localDate(2026, 5, 8, 12, 15);
    const next = nextCronTime('0,30 * * * *', from);
    expect(next.getMinutes()).toBe(30);
  });

  it('respects day-of-week', () => {
    // 2026-05-08 is a Friday (dow=5). "0 9 * * 1" = 9:00 AM Monday only
    const from = localDate(2026, 5, 8, 10, 0); // Friday
    const next = nextCronTime('0 9 * * 1', from);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('respects day-of-month', () => {
    const from = localDate(2026, 5, 8, 10, 0);
    const next = nextCronTime('0 9 15 * *', from);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(9);
  });
});

describe('msUntilNextCron', () => {
  it('returns positive milliseconds', () => {
    const ms = msUntilNextCron('* * * * *');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});

// ─── InMemoryTaskStore ────────────────────────────────────────

describe('InMemoryTaskStore', () => {
  it('saves and loads records', async () => {
    const store = new InMemoryTaskStore();
    await store.save({
      id: 't1',
      schedule: '0 9 * * *',
      enabled: true,
      nextRunAt: new Date().toISOString(),
      invocationCount: 0,
      createdAt: new Date().toISOString(),
    });
    const record = await store.load('t1');
    expect(record).toBeDefined();
    expect(record!.id).toBe('t1');
  });

  it('lists all records', async () => {
    const store = new InMemoryTaskStore();
    const now = new Date().toISOString();
    await store.save({ id: 'a', schedule: '* * * * *', enabled: true, nextRunAt: now, invocationCount: 0, createdAt: now });
    await store.save({ id: 'b', schedule: '* * * * *', enabled: true, nextRunAt: now, invocationCount: 0, createdAt: now });
    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it('deletes records', async () => {
    const store = new InMemoryTaskStore();
    const now = new Date().toISOString();
    await store.save({ id: 'x', schedule: '* * * * *', enabled: true, nextRunAt: now, invocationCount: 0, createdAt: now });
    await store.delete('x');
    const record = await store.load('x');
    expect(record).toBeUndefined();
  });
});

// ─── TaskScheduler ────────────────────────────────────────────

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;

  afterEach(async () => {
    scheduler.stop();
    await scheduler.dispose();
  });

  const makeDef = (overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition => ({
    id: 'test-task',
    schedule: { cron: '* * * * *' },
    task: async () => { /* noop */ },
    ...overrides,
  });

  it('registers a task and returns a record', async () => {
    scheduler = new TaskScheduler();
    const record = await scheduler.schedule(makeDef());
    expect(record.id).toBe('test-task');
    expect(record.enabled).toBe(true);
    expect(record.invocationCount).toBe(0);
    expect(record.nextRunAt).toBeDefined();
  });

  it('lists registered tasks', async () => {
    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({ id: 't1' }));
    await scheduler.schedule(makeDef({ id: 't2' }));
    const list = await scheduler.list();
    expect(list).toHaveLength(2);
  });

  it('removes a task', async () => {
    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({ id: 'to-remove' }));
    await scheduler.remove('to-remove');
    const record = await scheduler.get('to-remove');
    expect(record).toBeUndefined();
  });

  it('executes a task via trigger()', async () => {
    const fn = vi.fn();
    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({ id: 'trigger-test', task: fn }));

    await scheduler.trigger('trigger-test');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('updates invocationCount and lastRunAt after trigger()', async () => {
    const fn = vi.fn();
    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({ id: 'invoke-test', task: fn }));

    await scheduler.trigger('invoke-test');

    const record = await scheduler.get('invoke-test');
    expect(record).toBeDefined();
    expect(record!.invocationCount).toBe(1);
    expect(record!.lastRunAt).toBeDefined();
    expect(record!.lastResult).toBe('success');
  });

  it('executes retries on failure', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    });

    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({
      id: 'retry-test',
      task: fn,
      maxRetries: 3,
      retryDelayMs: 0,
    }));

    await scheduler.trigger('retry-test');

    expect(fn).toHaveBeenCalledTimes(3);
    const record = await scheduler.get('retry-test');
    expect(record!.lastResult).toBe('success');
  });

  it('reports failure after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'));

    scheduler = new TaskScheduler();
    await scheduler.schedule(makeDef({
      id: 'exhaust-test',
      task: fn,
      maxRetries: 1,
      retryDelayMs: 0,
    }));

    await scheduler.trigger('exhaust-test');

    const record = await scheduler.get('exhaust-test');
    expect(record!.lastResult).toBe('failure');
    expect(record!.lastError).toBe('always fail');
  });

  it('reports timeout', async () => {
    const fn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'ok';
    });

    scheduler = new TaskScheduler({ defaultTimeoutMs: 10 });
    await scheduler.schedule(makeDef({ id: 'timeout-test', task: fn }));

    await scheduler.trigger('timeout-test');

    const record = await scheduler.get('timeout-test');
    expect(record!.lastResult).toBe('timeout');
    expect(record!.lastError).toContain('timed out');
  });

  it('throws when triggering unknown task', async () => {
    scheduler = new TaskScheduler();
    await expect(scheduler.trigger('nonexistent')).rejects.toThrow('not found');
  });

  it('throws when scheduling on disposed scheduler', async () => {
    scheduler = new TaskScheduler();
    await scheduler.dispose();
    await expect(scheduler.schedule(makeDef())).rejects.toThrow('disposed');
  });

  it('supports custom store', async () => {
    const store = new InMemoryTaskStore();
    scheduler = new TaskScheduler({ store });

    await scheduler.schedule(makeDef({ id: 'store-test' }));

    const stored = await store.load('store-test');
    expect(stored).toBeDefined();
    expect(stored!.id).toBe('store-test');
  });
});
