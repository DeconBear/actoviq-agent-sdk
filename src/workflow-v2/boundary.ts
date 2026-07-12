import {
  WorkflowAbortedError,
  WorkflowTimeoutError,
} from './errors.js';

export async function withWorkflowBoundary<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new WorkflowAbortedError(parentSignal.reason);
  }

  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const timeoutError = new WorkflowTimeoutError(timeoutMs);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      const reason = signal.reason;
      finish(() => reject(
        reason instanceof WorkflowTimeoutError
          ? reason
          : new WorkflowAbortedError(reason),
      ));
    };
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: PromiseLike<T>;
    try {
      pending = Promise.resolve(operation(signal));
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(pending).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}
