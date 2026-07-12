import { describe, expect, it, vi } from 'vitest';

import type { DurableChildRecord } from '../src/orchestration/background.js';
import { DurableAgentScheduler } from '../src/scheduling/durableAgentScheduler.js';

describe('DurableAgentScheduler', () => {
  it('maps invocations to unique durable children and disables scheduler replay', async () => {
    const records = new Map<string, DurableChildRecord>();
    const spawn = vi.fn(async (request: any) => {
      records.set(request.childId, { childId: request.childId, status: 'queued' } as DurableChildRecord);
      return handle(request.childId);
    });
    const manager = {
      spawn,
      handle,
      query: async (childId: string) => {
        const record = records.get(childId);
        if (!record) throw new Error(`Unknown durable child "${childId}".`);
        return record;
      },
    };
    const scheduler = new DurableAgentScheduler({ manager });
    await scheduler.schedule({
      id: 'daily-research',
      schedule: { cron: '0 0 * * *' },
      agent: { id: 'worker', name: 'Worker', instructions: 'Work.' },
      input: 'research',
      parent: {} as any,
      effect: 'read',
      failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
      autoStart: false,
    });

    await scheduler.trigger('daily-research');
    await scheduler.trigger('daily-research');

    expect(spawn).toHaveBeenCalledTimes(2);
    const ids = spawn.mock.calls.map(call => call[0].childId as string);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => id.startsWith('scheduled:daily-research:'))).toBe(true);
    await scheduler.dispose();

    function handle(childId: string) {
      return {
        childId,
        query: () => manager.query(childId),
        result: async () => { throw new Error('not awaited'); },
        resume: async function () { return this; },
        cancel: async () => undefined,
      } as any;
    }
  });

  it('rejects retry-safe side effects before registration', async () => {
    const scheduler = new DurableAgentScheduler({ manager: {} as any });
    expect(() => scheduler.schedule({
      id: 'unsafe', schedule: { cron: '0 0 * * *' },
      agent: { id: 'worker', name: 'Worker', instructions: 'Work.' },
      input: 'work', parent: {} as any,
      effect: 'side-effect', failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    })).toThrow(/must be read or idempotent-write/);
    await scheduler.dispose();
  });
});
