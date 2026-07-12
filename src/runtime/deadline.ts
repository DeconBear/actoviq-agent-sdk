import {
  DeadlineExceededError,
  RunAbortedError,
} from '../errors.js';

export interface DeadlineContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly scope: string;
}

/**
 * Run an operation with a finite wall-clock deadline and a derived signal.
 * The race rejects even when a third-party callback ignores AbortSignal; the
 * derived signal still lets cooperative model/tool/MCP/hook work stop early.
 */
export async function withDeadline<T>(
  scope: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (context: DeadlineContext) => Promise<T> | T,
): Promise<T> {
  assertTimeout(timeoutMs, scope);
  if (parentSignal?.aborted) {
    throw toAbortError(parentSignal.reason);
  }

  const deadlineError = new DeadlineExceededError(scope, timeoutMs);
  const deadlineController = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, deadlineController.signal])
    : deadlineController.signal;

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
        reason instanceof DeadlineExceededError ? reason : toAbortError(reason),
      ));
    };
    const timer = setTimeout(() => deadlineController.abort(deadlineError), timeoutMs);
    if (typeof timer === 'object') {
      timer.unref?.();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation({ signal, timeoutMs, scope }));
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

export function assertTimeout(timeoutMs: number, name = 'timeoutMs'): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function toAbortError(reason: unknown): RunAbortedError {
  if (reason instanceof RunAbortedError) {
    return reason;
  }
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === 'string' && reason.length > 0
      ? reason
      : 'The run was aborted.';
  return new RunAbortedError(message, { cause: reason });
}
