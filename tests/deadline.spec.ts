import { describe, expect, it } from 'vitest';

import { withDeadline } from '../src/runtime/deadline.js';

describe('withDeadline', () => {
  it('resolves cooperative work and provides a live derived signal', async () => {
    await expect(withDeadline('fast work', 100, undefined, ({ signal }) => {
      expect(signal.aborted).toBe(false);
      return Promise.resolve('done');
    })).resolves.toBe('done');
  });

  it('rejects on the wall-clock deadline even when work ignores the signal', async () => {
    let derivedSignal: AbortSignal | undefined;
    const never = withDeadline('hung tool', 20, undefined, ({ signal }) => {
      derivedSignal = signal;
      return new Promise<string>(() => {});
    });

    await expect(never).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
      scope: 'hung tool',
      timeoutMs: 20,
    });
    expect(derivedSignal?.aborted).toBe(true);
  });

  it('propagates parent cancellation as RUN_ABORTED', async () => {
    const controller = new AbortController();
    const pending = withDeadline('parented work', 1_000, controller.signal, () =>
      new Promise<string>(() => {}));
    controller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toMatchObject({
      code: 'RUN_ABORTED',
      message: 'caller cancelled',
    });
  });
});
