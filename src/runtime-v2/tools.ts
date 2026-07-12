export type ToolEffect = 'read' | 'idempotent-write' | 'side-effect';

export interface ToolSchema<T> {
  parse(value: unknown): T;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface ToolArtifact {
  readonly id: string;
  readonly mediaType?: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolOutput<T> {
  readonly value: T;
  readonly artifacts?: readonly ToolArtifact[];
  readonly modelText?: string;
}

export interface ToolBehavior<TInput = unknown> {
  /** Missing declarations are deliberately treated as side effects. */
  readonly effect?: ToolEffect;
  readonly concurrencyKey?: string | ((input: TInput) => string);
  readonly timeoutMs?: number;
  readonly requiresApproval?: boolean;
}

export interface ToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: ToolSchema<TInput>;
  readonly output?: ToolSchema<TOutput>;
  readonly behavior?: ToolBehavior<TInput>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionContext<TContext = unknown> {
  readonly runId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  /** Absolute Unix epoch boundary inherited from the run. */
  readonly deadline?: number;
  readonly context: TContext;
  readonly idempotencyKey?: string;
  readonly approval?: {
    readonly interruptionId: string;
    readonly outcome: 'approve';
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly workspaceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeTool<TContext = unknown, TInput = unknown, TOutput = unknown> {
  readonly descriptor: ToolDescriptor<TInput, TOutput>;
  execute(
    context: ToolExecutionContext<TContext>,
    input: TInput,
  ): Promise<ToolOutput<TOutput> | TOutput> | ToolOutput<TOutput> | TOutput;
}

export type ToolPolicyDecision =
  | { readonly type: 'allow' }
  | { readonly type: 'deny'; readonly reason: string }
  | {
      readonly type: 'interrupt';
      readonly interruptionId: string;
      readonly reason: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

export interface ToolPolicyRequest<TContext = unknown> {
  readonly tool: ToolDescriptor;
  readonly input: unknown;
  readonly context: ToolExecutionContext<TContext>;
}

export interface ToolPolicy<TContext = unknown> {
  authorize(request: ToolPolicyRequest<TContext>): Promise<ToolPolicyDecision> | ToolPolicyDecision;
}

export interface ToolFailure {
  readonly kind: 'not_found' | 'validation' | 'denied' | 'timeout' | 'cancelled' | 'execution';
  readonly toolName: string;
  readonly callId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface ToolErrorFormatter {
  format(failure: ToolFailure): string;
}

export class ToolExecutionError extends Error {
  constructor(readonly failure: ToolFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = 'ToolExecutionError';
  }
}

export class ToolInterruptionRequiredError extends Error {
  constructor(
    readonly decision: Extract<ToolPolicyDecision, { type: 'interrupt' }>,
    readonly toolName: string,
    readonly callId: string,
  ) {
    super(decision.reason);
    this.name = 'ToolInterruptionRequiredError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool<any, any, any>>();

  constructor(tools: Iterable<RuntimeTool<any, any, any>> = []) {
    for (const tool of tools) this.register(tool);
  }

  register<TContext, TInput, TOutput>(tool: RuntimeTool<TContext, TInput, TOutput>): void {
    const name = tool.descriptor.name.trim();
    if (!name) throw new TypeError('Tool name must not be empty.');
    if (this.tools.has(name)) throw new Error(`Tool "${name}" is already registered.`);
    if (typeof tool.execute !== 'function') throw new TypeError(`Tool "${name}" must provide execute().`);
    this.tools.set(name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  resolve<TContext = unknown, TInput = unknown, TOutput = unknown>(
    name: string,
  ): RuntimeTool<TContext, TInput, TOutput> | undefined {
    return this.tools.get(name) as RuntimeTool<TContext, TInput, TOutput> | undefined;
  }

  list(): readonly ToolDescriptor<any, any>[] {
    return Object.freeze([...this.tools.values()]
      .map(tool => tool.descriptor)
      .sort((left, right) => left.name.localeCompare(right.name)));
  }
}

export interface ToolRunnerOptions<TContext = unknown> {
  readonly registry: ToolRegistry;
  readonly policy?: ToolPolicy<TContext>;
  readonly errorFormatter?: ToolErrorFormatter;
}

/**
 * Applies invariant validation, policy and cancellation around one execution.
 * It never retries: a runtime may only retry with explicit effect/idempotency rules.
 */
export class ToolRunner<TContext = unknown> {
  private readonly registry: ToolRegistry;
  private readonly policy?: ToolPolicy<TContext>;
  private readonly errorFormatter: ToolErrorFormatter;

  constructor(options: ToolRunnerOptions<TContext>) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.errorFormatter = options.errorFormatter ?? DEFAULT_TOOL_ERROR_FORMATTER;
  }

  async execute<TOutput = unknown>(
    name: string,
    input: unknown,
    context: ToolExecutionContext<TContext>,
  ): Promise<ToolOutput<TOutput>> {
    const tool = this.registry.resolve<TContext, unknown, TOutput>(name);
    if (!tool) throw this.failure('not_found', name, context, `Unknown tool "${name}".`, false);

    let parsedInput: unknown;
    try {
      parsedInput = tool.descriptor.input.parse(input);
    } catch (cause) {
      throw this.failure('validation', name, context, `Invalid input for tool "${name}".`, false, cause);
    }

    const requiresApproval = tool.descriptor.behavior?.requiresApproval === true;
    const decision = this.policy
      ? await this.authorize(tool.descriptor, parsedInput, context, requiresApproval)
      : requiresApproval && context.approval?.outcome === 'approve'
        ? { type: 'allow' } as const
        : await this.authorize(tool.descriptor, parsedInput, context, requiresApproval);
    if (decision.type === 'deny') {
      throw this.failure('denied', name, context, decision.reason, false);
    }
    if (decision.type === 'interrupt') {
      throw new ToolInterruptionRequiredError(decision, name, context.callId);
    }

    const execution = deriveExecutionBoundary(context, tool.descriptor.behavior?.timeoutMs);
    try {
      const raw = await raceWithSignal(
        Promise.resolve(tool.execute({ ...context, signal: execution.signal }, parsedInput)),
        execution.signal,
      );
      const normalized = isToolOutput<TOutput>(raw) ? raw : { value: raw as TOutput };
      if (!tool.descriptor.output) return normalized;
      try {
        return { ...normalized, value: tool.descriptor.output.parse(normalized.value) };
      } catch (cause) {
        throw this.failure(
          'validation',
          name,
          context,
          `Invalid output from tool "${name}".`,
          false,
          cause,
        );
      }
    } catch (error) {
      if (error instanceof ToolExecutionError || error instanceof ToolInterruptionRequiredError) throw error;
      if (execution.timedOut()) {
        throw this.failure('timeout', name, context, `Tool "${name}" exceeded its deadline.`, false, error);
      }
      if (context.signal.aborted || execution.signal.aborted) {
        throw this.failure('cancelled', name, context, `Tool "${name}" was cancelled.`, false, error);
      }
      throw this.failure('execution', name, context, `Tool "${name}" failed.`, false, error);
    } finally {
      execution.dispose();
    }
  }

  formatFailure(error: ToolExecutionError): string {
    return this.errorFormatter.format(error.failure);
  }

  private async authorize(
    tool: ToolDescriptor,
    input: unknown,
    context: ToolExecutionContext<TContext>,
    requiresApproval: boolean,
  ): Promise<ToolPolicyDecision> {
    if (this.policy) return this.policy.authorize({ tool, input, context });
    if (requiresApproval) {
      return {
        type: 'interrupt',
        interruptionId: `${context.runId}:${context.callId}`,
        reason: `Tool "${tool.name}" requires approval.`,
      };
    }
    return { type: 'allow' };
  }

  private failure(
    kind: ToolFailure['kind'],
    toolName: string,
    context: ToolExecutionContext<TContext>,
    message: string,
    retryable: boolean,
    cause?: unknown,
  ): ToolExecutionError {
    return new ToolExecutionError(
      { kind, toolName, callId: context.callId, message, retryable, cause },
      cause === undefined ? undefined : { cause },
    );
  }
}

export function toolEffect(descriptor: ToolDescriptor<any, any>): ToolEffect {
  return descriptor.behavior?.effect ?? 'side-effect';
}

const DEFAULT_TOOL_ERROR_FORMATTER: ToolErrorFormatter = Object.freeze({
  format: (failure: ToolFailure) => `${failure.kind}: ${failure.message}`,
});

function isToolOutput<T>(value: unknown): value is ToolOutput<T> {
  return typeof value === 'object' && value !== null && 'value' in value;
}

interface ExecutionBoundary {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function deriveExecutionBoundary(
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): ExecutionBoundary {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError('Tool timeoutMs must be a positive finite number.');
  }
  const now = Date.now();
  const expiresAt = Math.min(
    context.deadline ?? Number.POSITIVE_INFINITY,
    timeoutMs === undefined ? Number.POSITIVE_INFINITY : now + timeoutMs,
  );
  if (!Number.isFinite(expiresAt)) {
    return { signal: context.signal, timedOut: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = expiresAt <= now;
  const onParentAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Tool deadline exceeded.'));
  }, Math.max(0, expiresAt - now));
  timer.unref?.();
  if (context.signal.aborted) onParentAbort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onParentAbort);
    },
  };
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Operation aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
