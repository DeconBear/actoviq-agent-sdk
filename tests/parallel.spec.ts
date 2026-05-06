import { describe, expect, it } from 'vitest';

import { parallel, race } from '../src/runtime/parallel.js';

describe('parallel', () => {
  it('runs all tasks and returns results in order', async () => {
    const results = await parallel([
      async () => 1,
      async () => 2,
      async () => 3,
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  it('returns empty array for no tasks', async () => {
    const results = await parallel([]);
    expect(results).toEqual([]);
  });

  it('respects maxConcurrency', async () => {
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return i;
    });

    await parallel(tasks, { maxConcurrency: 2 });
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('throws when all tasks fail', async () => {
    await expect(
      parallel([
        async () => {
          throw new Error('e1');
        },
        async () => {
          throw new Error('e2');
        },
      ]),
    ).rejects.toThrow('All tasks failed');
  });

  it('returns partial results when some tasks fail without failFast', async () => {
    const results = await parallel([
      async () => 1,
      async () => {
        throw new Error('e2');
      },
      async () => 3,
    ]);

    expect(results[0]).toBe(1);
    expect(results[2]).toBe(3);
  });

  it('fails fast when failFast is true', async () => {
    let thirdStarted = false;

    await expect(
      parallel(
        [
          async () => {
            await new Promise((r) => setTimeout(r, 10));
            throw new Error('first fails');
          },
          async () => {
            await new Promise((r) => setTimeout(r, 100));
            return 2;
          },
          async () => {
            thirdStarted = true;
            return 3;
          },
        ],
        { failFast: true, maxConcurrency: 2 },
      ),
    ).rejects.toThrow('first fails');
  });

  it('handles abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      parallel(
        [async () => 1, async () => 2],
        { signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
  });
});

describe('race', () => {
  it('returns the fastest result', async () => {
    const winner = await race([
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'slow';
      },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'fast';
      },
    ]);

    expect(winner).toBe('fast');
  });

  it('throws when no tasks given', async () => {
    await expect(race([])).rejects.toThrow('race() requires at least one task');
  });

  it('times out with timeoutMs', async () => {
    await expect(
      race(
        [
          async () => {
            await new Promise((r) => setTimeout(r, 200));
            return 'too slow';
          },
        ],
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow('timed out');
  });

  it('handles abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      race([async () => 1], { signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });
});
