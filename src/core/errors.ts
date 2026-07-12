import type { JsonObject } from './json.js';

export type RunPhase =
  | 'prepare_input'
  | 'before_run'
  | 'model_call'
  | 'tool_call'
  | 'handoff'
  | 'finalize_output'
  | 'after_run'
  | 'runtime';

export interface RunErrorOptions {
  readonly code?: string;
  readonly runId?: string;
  readonly phase?: RunPhase;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
  readonly cause?: unknown;
}

export interface SerializedRunError {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly runId?: string;
  readonly phase?: RunPhase;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export class RunError extends Error {
  readonly code: string;
  readonly runId?: string;
  readonly phase?: RunPhase;
  readonly retryable: boolean;
  readonly details?: JsonObject;

  constructor(message: string, options: RunErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'RUN_ERROR';
    this.runId = options.runId;
    this.phase = options.phase;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): SerializedRunError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export interface CapabilityErrorOptions {
  readonly providerId?: string;
  readonly model?: string;
  readonly capability?: string;
  readonly cause?: unknown;
}

/** Raised during capability preflight, before a provider request is sent. */
export class CapabilityError extends RunError {
  readonly providerId?: string;
  readonly model?: string;
  readonly capability?: string;

  constructor(message: string, options: CapabilityErrorOptions = {}) {
    const details: Record<string, string> = {};
    if (options.providerId !== undefined) details.providerId = options.providerId;
    if (options.model !== undefined) details.model = options.model;
    if (options.capability !== undefined) details.capability = options.capability;

    super(message, {
      code: 'CAPABILITY_ERROR',
      phase: 'model_call',
      retryable: false,
      details,
      cause: options.cause,
    });
    this.providerId = options.providerId;
    this.model = options.model;
    this.capability = options.capability;
  }
}
