import type { ParallelOptions, RaceOptions } from '../types.js';
import { ActoviqSdkError } from '../errors.js';

export async function parallel<T>(
  tasks: Array<() => Promise<T>>,
  options: ParallelOptions = {},
): Promise<T[]> {
  const { maxConcurrency = 5, failFast = false, signal } = options;

  if (tasks.length === 0) return [];

  const results = new Array<T>(tasks.length);
  const errors: Array<{ index: number; error: Error }> = [];
  let nextIndex = 0;
  let running = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length && !done && !signal?.aborted) {
      const index = nextIndex++;
      const task = tasks[index];
      if (!task) continue;
      try {
        const result = await task();
        results[index] = result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ index, error });
        if (failFast) {
          done = true;
          throw error;
        }
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(maxConcurrency, tasks.length); i++) {
    workers.push(worker());
    running++;
  }

  // Wait for all workers to settle, collecting the first error for failFast
  let firstError: Error | undefined;
  const settled = await Promise.allSettled(workers);
  for (const s of settled) {
    if (s.status === 'rejected') {
      firstError = firstError ?? (s.reason instanceof Error ? s.reason : new Error(String(s.reason)));
    }
  }

  if (signal?.aborted) {
    throw new ActoviqSdkError('Parallel execution aborted');
  }

  if (firstError && failFast) {
    throw firstError;
  }

  if (errors.length === tasks.length) {
    throw new ActoviqSdkError(
      `All tasks failed: ${errors.map((e) => e.error.message).join('; ')}`,
    );
  }

  return results;
}

export async function race<T>(
  tasks: Array<() => Promise<T>>,
  options: RaceOptions = {},
): Promise<T> {
  const { timeoutMs, signal } = options;

  if (tasks.length === 0) {
    throw new ActoviqSdkError('race() requires at least one task');
  }

  const contenders: Promise<{ value: T }>[] = tasks.map((t) =>
    t().then((value) => ({ value })),
  );

  if (timeoutMs !== undefined) {
    contenders.push(
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ActoviqSdkError(`race() timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    );
  }

  if (signal) {
    contenders.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new ActoviqSdkError('race() aborted'));
        } else {
          signal.addEventListener('abort', () =>
            reject(new ActoviqSdkError('race() aborted')),
          );
        }
      }),
    );
  }

  const winner = await Promise.race(contenders);
  return winner.value;
}
