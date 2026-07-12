import {
  MIDDLEWARE_STAGE_ORDER,
  MiddlewareStage,
  isMiddlewareStage,
  middlewareStageIndex,
} from './stages.js';
import type {
  AnyMiddlewareDefinition,
  DefaultMiddlewareContext,
  MaybePromise,
  MiddlewareDefinition,
  MiddlewareErrorContext,
  MiddlewareHandler,
  MiddlewareInspectionEntry,
  MiddlewareInvocationContext,
  MiddlewareStageContext,
} from './types.js';

interface StoredDefinition {
  readonly name: string;
  readonly stage: MiddlewareStage;
  readonly priority: number;
  readonly registrationIndex: number;
  readonly handle: MiddlewareHandler;
}

export class MiddlewareConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MiddlewareConfigurationError';
  }
}

export class MiddlewarePriorityConflictError extends MiddlewareConfigurationError {
  readonly stage: MiddlewareStage;
  readonly priority: number;
  readonly middlewareNames: readonly string[];

  constructor(stage: MiddlewareStage, priority: number, middlewareNames: readonly string[]) {
    const names = Object.freeze([...middlewareNames].sort((left, right) => left.localeCompare(right)));
    super(
      `Middleware priority conflict at ${stage}@${priority}: ${names.join(', ')}. `
      + 'Each stage must use unique priorities.',
    );
    this.name = 'MiddlewarePriorityConflictError';
    this.stage = stage;
    this.priority = priority;
    this.middlewareNames = names;
  }
}

export class MiddlewareNextCalledTwiceError extends Error {
  constructor(stage: MiddlewareStage, middlewareName: string) {
    super(`Middleware "${middlewareName}" called next() more than once at ${stage}.`);
    this.name = 'MiddlewareNextCalledTwiceError';
  }
}

export class MiddlewareDeadlineExceededError extends Error {
  readonly stage: MiddlewareStage;
  readonly expiresAt: number;
  readonly scope?: string;

  constructor(stage: MiddlewareStage, expiresAt: number, scope?: string) {
    super(`Middleware deadline${scope ? ` for ${scope}` : ''} expired at ${expiresAt}.`);
    this.name = 'MiddlewareDeadlineExceededError';
    this.stage = stage;
    this.expiresAt = expiresAt;
    this.scope = scope;
  }
}

/** Collects registrations and validates the complete graph only at build time. */
export class MiddlewarePipelineBuilder {
  private readonly definitions: AnyMiddlewareDefinition[] = [];

  use<
    TStage extends MiddlewareStage,
    TContext extends MiddlewareInvocationContext,
    TResult,
  >(definition: MiddlewareDefinition<TStage, TContext, TResult>): this {
    this.definitions.push(definition);
    return this;
  }

  useAll(definitions: Iterable<AnyMiddlewareDefinition>): this {
    for (const definition of definitions) {
      this.use(definition);
    }
    return this;
  }

  build(): MiddlewarePipeline {
    return new MiddlewarePipeline(this.definitions);
  }
}

/** Immutable, deterministic middleware execution plan. */
export class MiddlewarePipeline {
  private readonly byStage: ReadonlyMap<MiddlewareStage, readonly StoredDefinition[]>;
  private readonly inspection: readonly MiddlewareInspectionEntry[];
  private readonly registeredDefinitions: readonly AnyMiddlewareDefinition[];

  constructor(definitions: Iterable<AnyMiddlewareDefinition> = []) {
    const stored = [...definitions].map((definition, registrationIndex) =>
      validateDefinition(definition, registrationIndex));
    assertNoPriorityConflicts(stored);

    stored.sort((left, right) =>
      middlewareStageIndex(left.stage) - middlewareStageIndex(right.stage)
      || left.priority - right.priority
      || left.registrationIndex - right.registrationIndex);

    this.registeredDefinitions = Object.freeze(stored.map(definition => Object.freeze({
      name: definition.name,
      stage: definition.stage,
      priority: definition.priority,
      handle: definition.handle,
    })));

    const byStage = new Map<MiddlewareStage, readonly StoredDefinition[]>();
    for (const stage of MIDDLEWARE_STAGE_ORDER) {
      const handlers = stored.filter(definition => definition.stage === stage);
      byStage.set(stage, Object.freeze(handlers));
    }
    this.byStage = byStage;

    const chainPositions = new Map<MiddlewareStage, number>();
    this.inspection = Object.freeze(stored.map(definition => {
      const chainIndex = chainPositions.get(definition.stage) ?? 0;
      chainPositions.set(definition.stage, chainIndex + 1);
      return Object.freeze({
        name: definition.name,
        stage: definition.stage,
        priority: definition.priority,
        stageIndex: middlewareStageIndex(definition.stage),
        chainIndex,
      });
    }));
  }

  /** A serializable view that intentionally excludes executable handlers. */
  inspect(stage?: MiddlewareStage): readonly MiddlewareInspectionEntry[] {
    if (stage === undefined) {
      return this.inspection;
    }
    assertKnownStage(stage);
    return Object.freeze(this.inspection.filter(entry => entry.stage === stage));
  }

  /** Executable definitions for deterministic composition with agent-local refs. */
  definitions(): readonly AnyMiddlewareDefinition[] {
    return this.registeredDefinitions;
  }

  /** Deterministic, human-readable execution order for startup diagnostics. */
  format(stage?: MiddlewareStage): string {
    return this.inspect(stage)
      .map(entry => `${entry.stage}[${entry.chainIndex}] @${entry.priority} ${entry.name}`)
      .join('\n');
  }

  /**
   * Execute one stage using onion-style `context, next` composition.
   * Not calling `next` is an intentional short circuit. Downstream errors flow
   * back through earlier handlers and can be observed or recovered there.
   */
  run<
    TStage extends MiddlewareStage,
    TContext extends MiddlewareInvocationContext,
    TResult,
  >(
    stage: TStage,
    context: TContext,
    terminal: (context: MiddlewareStageContext<TStage, TContext>) => MaybePromise<TResult>,
  ): Promise<TResult> {
    assertKnownStage(stage);
    validateInvocationContext(context);
    const stageContext = {
      ...context,
      stage,
    } as MiddlewareStageContext<TStage, TContext>;
    const handlers = this.byStage.get(stage) ?? [];

    let furthestDispatch = -1;
    const dispatch = async (index: number): Promise<TResult> => {
      if (index <= furthestDispatch) {
        const previous = handlers[Math.max(0, index - 1)];
        throw new MiddlewareNextCalledTwiceError(stage, previous?.name ?? '<terminal>');
      }
      furthestDispatch = index;
      assertInvocationActive(stage, stageContext);

      const definition = handlers[index];
      if (!definition) {
        return terminal(stageContext);
      }

      const handle = definition.handle as MiddlewareHandler<TStage, TContext, TResult>;
      return handle(stageContext, () => dispatch(index + 1));
    };

    return dispatch(0);
  }

  /**
   * Execute a stage and route an unhandled failure through the explicit
   * `onError` stage. An onError middleware may recover by short-circuiting or
   * preserve the failure by calling `next()`.
   */
  async runWithErrorStage<
    TStage extends Exclude<MiddlewareStage, MiddlewareStage.OnError>,
    TContext extends MiddlewareInvocationContext,
    TResult,
  >(
    stage: TStage,
    context: TContext,
    terminal: (context: MiddlewareStageContext<TStage, TContext>) => MaybePromise<TResult>,
  ): Promise<TResult> {
    try {
      return await this.run(stage, context, terminal);
    } catch (error) {
      const errorContext: MiddlewareErrorContext<TContext> = {
        signal: context.signal,
        deadline: context.deadline,
        failedStage: stage,
        error,
        sourceContext: context,
      };
      return this.run(MiddlewareStage.OnError, errorContext, () => {
        throw error;
      });
    }
  }
}

export function createMiddlewarePipelineBuilder(): MiddlewarePipelineBuilder {
  return new MiddlewarePipelineBuilder();
}

export function buildMiddlewarePipeline(
  definitions: Iterable<AnyMiddlewareDefinition> = [],
): MiddlewarePipeline {
  return new MiddlewarePipelineBuilder().useAll(definitions).build();
}

export function defineMiddleware<
  TStage extends MiddlewareStage,
  TContext extends MiddlewareInvocationContext = DefaultMiddlewareContext<TStage>,
  TResult = unknown,
>(
  definition: MiddlewareDefinition<TStage, TContext, TResult>,
): MiddlewareDefinition<TStage, TContext, TResult> {
  return Object.freeze({ ...definition });
}

function validateDefinition(
  definition: AnyMiddlewareDefinition,
  registrationIndex: number,
): StoredDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new MiddlewareConfigurationError('Middleware definition must be an object.');
  }
  const name = definition.name.trim();
  if (name.length === 0) {
    throw new MiddlewareConfigurationError('Middleware name must not be empty.');
  }
  if (!isMiddlewareStage(definition.stage)) {
    throw new MiddlewareConfigurationError(
      `Middleware "${name}" has an unknown stage: ${String(definition.stage)}.`,
    );
  }
  if (!Number.isSafeInteger(definition.priority)) {
    throw new MiddlewareConfigurationError(
      `Middleware "${name}" priority must be a safe integer.`,
    );
  }
  if (typeof definition.handle !== 'function') {
    throw new MiddlewareConfigurationError(`Middleware "${name}" must provide handle().`);
  }
  return Object.freeze({
    name,
    stage: definition.stage,
    priority: definition.priority,
    registrationIndex,
    handle: definition.handle,
  });
}

function assertNoPriorityConflicts(definitions: readonly StoredDefinition[]): void {
  const grouped = new Map<string, StoredDefinition[]>();
  for (const definition of definitions) {
    const key = `${definition.stage}\u0000${definition.priority}`;
    const group = grouped.get(key);
    if (group) {
      group.push(definition);
    } else {
      grouped.set(key, [definition]);
    }
  }
  for (const group of grouped.values()) {
    if (group.length > 1) {
      const first = group[0];
      if (!first) continue;
      throw new MiddlewarePriorityConflictError(
        first.stage,
        first.priority,
        group.map(definition => definition.name),
      );
    }
  }
}

function assertKnownStage(stage: MiddlewareStage): void {
  if (!isMiddlewareStage(stage)) {
    throw new TypeError(`Unknown middleware stage: ${String(stage)}.`);
  }
}

function validateInvocationContext(context: MiddlewareInvocationContext): void {
  if (!context || typeof context !== 'object') {
    throw new TypeError('Middleware context must be an object.');
  }
  if (!(context.signal instanceof AbortSignal)) {
    throw new TypeError('Middleware context.signal must be an AbortSignal.');
  }
  if (
    context.deadline !== undefined
    && (!Number.isFinite(context.deadline.expiresAt) || context.deadline.expiresAt < 0)
  ) {
    throw new TypeError('Middleware context.deadline.expiresAt must be a non-negative finite number.');
  }
}

function assertInvocationActive(
  stage: MiddlewareStage,
  context: MiddlewareInvocationContext,
): void {
  context.signal.throwIfAborted();
  if (context.deadline && Date.now() >= context.deadline.expiresAt) {
    throw new MiddlewareDeadlineExceededError(
      stage,
      context.deadline.expiresAt,
      context.deadline.scope,
    );
  }
}
