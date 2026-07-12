import type { MiddlewareStage } from './stages.js';

export type MaybePromise<T> = T | PromiseLike<T>;

/** Absolute wall-clock boundary carried through a middleware invocation. */
export interface MiddlewareDeadline {
  /** Unix epoch time in milliseconds. */
  readonly expiresAt: number;
  /** Optional diagnostic label supplied by the runtime. */
  readonly scope?: string;
}

/**
 * Minimum context shared by every stage.
 *
 * A runtime can extend this interface with run, model, tool, or handoff data.
 * The pipeline passes `signal` and `deadline` through unchanged.
 */
export interface MiddlewareInvocationContext {
  readonly signal: AbortSignal;
  readonly deadline?: MiddlewareDeadline;
}

export interface MiddlewareErrorContext<
  TContext extends MiddlewareInvocationContext = MiddlewareInvocationContext,
> extends MiddlewareInvocationContext {
  readonly failedStage: MiddlewareStage;
  readonly error: unknown;
  readonly sourceContext: TContext;
}

export type DefaultMiddlewareContext<TStage extends MiddlewareStage> =
  TStage extends MiddlewareStage.OnError
    ? MiddlewareErrorContext
    : MiddlewareInvocationContext;

export type MiddlewareStageContext<
  TStage extends MiddlewareStage,
  TContext extends MiddlewareInvocationContext,
> = Omit<TContext, 'stage'> & { readonly stage: TStage };

export type MiddlewareNext<TResult> = () => Promise<TResult>;

export type MiddlewareHandler<
  TStage extends MiddlewareStage = MiddlewareStage,
  TContext extends MiddlewareInvocationContext = DefaultMiddlewareContext<TStage>,
  TResult = unknown,
> = (
  context: MiddlewareStageContext<TStage, TContext>,
  next: MiddlewareNext<TResult>,
) => MaybePromise<TResult>;

/** One independently composable handler at one lifecycle stage. */
export interface MiddlewareDefinition<
  TStage extends MiddlewareStage = MiddlewareStage,
  TContext extends MiddlewareInvocationContext = DefaultMiddlewareContext<TStage>,
  TResult = unknown,
> {
  /** Stable diagnostic identity; a name may be reused at different stages. */
  readonly name: string;
  readonly stage: TStage;
  /** Lower priorities execute first and therefore wrap higher priorities. */
  readonly priority: number;
  readonly handle: MiddlewareHandler<TStage, TContext, TResult>;
}

/** Type-erased definition used only while composing heterogeneous stages. */
export type AnyMiddlewareDefinition = MiddlewareDefinition<any, any, any>;

export interface MiddlewareInspectionEntry {
  readonly name: string;
  readonly stage: MiddlewareStage;
  readonly priority: number;
  /** Zero-based lifecycle position from the fixed stage table. */
  readonly stageIndex: number;
  /** Zero-based position inside this stage's composed chain. */
  readonly chainIndex: number;
}
