import { randomUUID } from 'node:crypto';

import type { JsonObject, JsonValue } from '../core/index.js';
import type {
  ChildFailurePolicy,
  ChildRunOutcome,
  ChildRunRequest,
  ChildRunSuccess,
  OrchestrationRuntime,
  OrchestrationScope,
  SerializedChildError,
} from './contracts.js';
import { ChildRunError } from './contracts.js';
import { RunTreeController } from './scope.js';

const DEFAULT_FAILURE_POLICY: ChildFailurePolicy = Object.freeze({ mode: 'fail-fast' });

/** Executes exactly one logical child; composition lives in higher-level primitives. */
export class ChildRunner {
  constructor(
    readonly runtime: OrchestrationRuntime,
    readonly tree = new RunTreeController(),
  ) {}

  async run<TContext, TOutput = string>(
    request: ChildRunRequest<TContext, TOutput>,
  ): Promise<ChildRunOutcome<TOutput>> {
    if (request.parent.services !== this.runtime.services) {
      throw new Error('Child scope must inherit the OrchestrationRuntime RuntimeServices instance.');
    }
    const policy = request.failurePolicy ?? DEFAULT_FAILURE_POLICY;
    validateFailurePolicy(policy, request.effect ?? 'side-effect', request.idempotencyKey);

    const scope = this.tree.deriveChild(request.parent, request.runId ?? randomUUID());
    try {
      scope.budget.claimChild(scope.depth);
      return await this.executeAttempts(request, scope, policy);
    } finally {
      this.tree.complete(scope.runId);
    }
  }

  private async executeAttempts<TContext, TOutput>(
    request: ChildRunRequest<TContext, TOutput>,
    scope: OrchestrationScope,
    policy: ChildFailurePolicy,
  ): Promise<ChildRunOutcome<TOutput>> {
    const maxAttempts = policy.mode === 'retry-safe' ? policy.maxAttempts : 1;
    let lastError: unknown;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        const result = await scope.concurrency.run(
          () => raceWithSignal(this.runtime.run(request.agent, request.input, {
            context: request.context,
            signal: scope.signal,
            sessionId: sessionIdFor(request, scope),
            tenantId: scope.tenantSession.tenantId,
            workspaceId: scope.workspacePolicy.workspaceId,
            metadata: runtimeMetadata(request.metadata, scope, request.effect, request.idempotencyKey, attempt),
            runId: scope.runId,
            parentRunId: scope.parentRunId,
            parentTrace: request.parent.trace,
            orchestration: scope,
          }), scope.signal),
          { signal: scope.signal, key: scope.runId },
        );
        scope.budget.recordUsage(result.usage);
        const outcome: ChildRunSuccess<TOutput> = {
          status: 'completed',
          attempts: attempt,
          scope,
          result,
        };
        return outcome;
      } catch (error) {
        lastError = error;
        if (scope.signal.aborted) break;
        if (
          policy.mode === 'retry-safe'
          && attempt < maxAttempts
          && (policy.retryWhen?.(error, attempt) ?? true)
        ) {
          continue;
        }
        break;
      }
    }

    const attempts = attemptsMade;
    if (policy.mode === 'collect') {
      return {
        status: 'failed',
        attempts,
        scope,
        error: serializeChildError(lastError),
      };
    }
    throw new ChildRunError(
      `Child run "${scope.runId}" failed after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
      scope.runId,
      attempts,
      { cause: lastError },
    );
  }
}

export function serializeChildError(error: unknown): SerializedChildError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    return {
      name: error.name || 'Error',
      message: error.message,
      code: typeof withCode.code === 'string' ? withCode.code : undefined,
    };
  }
  return { name: 'Error', message: String(error) };
}

function validateFailurePolicy(
  policy: ChildFailurePolicy,
  effect: 'read' | 'idempotent-write' | 'side-effect',
  idempotencyKey: string | undefined,
): void {
  if (policy.mode !== 'retry-safe') return;
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 2) {
    throw new RangeError('retry-safe maxAttempts must be a safe integer of at least 2.');
  }
  if (effect === 'side-effect') {
    throw new Error('retry-safe is only valid for read or idempotent-write child executions.');
  }
  if (effect === 'idempotent-write' && !idempotencyKey?.trim()) {
    throw new Error('retry-safe idempotent-write execution requires an idempotencyKey.');
  }
}

function runtimeMetadata(
  metadata: Readonly<JsonObject> | undefined,
  scope: OrchestrationScope,
  effect: 'read' | 'idempotent-write' | 'side-effect' | undefined,
  idempotencyKey: string | undefined,
  attempt: number,
): JsonObject {
  const orchestration: Record<string, JsonValue> = {
    runId: scope.runId,
    parentRunId: scope.parentRunId ?? null,
    depth: scope.depth,
    deadline: scope.deadline ?? null,
    trace: {
      traceId: scope.trace.traceId,
      spanId: scope.trace.spanId,
      parentSpanId: scope.trace.parentSpanId ?? null,
    },
    securityPolicy: {
      id: scope.securityPolicy.id,
      version: scope.securityPolicy.version ?? null,
      attributes: scope.securityPolicy.attributes ?? {},
    },
    tenantSession: {
      tenantId: scope.tenantSession.tenantId,
      namespace: scope.tenantSession.namespace,
      sessionId: scope.tenantSession.sessionId ?? null,
    },
    workspacePolicy: {
      workspaceId: scope.workspacePolicy.workspaceId ?? null,
      root: scope.workspacePolicy.root ?? null,
      access: scope.workspacePolicy.access,
      allowedRoots: scope.workspacePolicy.allowedRoots ?? [],
    },
    budget: budgetJson(scope),
    effect: effect ?? 'side-effect',
    idempotencyKey: idempotencyKey ?? null,
    attempt,
  };
  return {
    ...(metadata ?? {}),
    orchestration,
  };
}

function budgetJson(scope: OrchestrationScope): JsonObject {
  const snapshot = scope.budget.snapshot();
  return {
    limits: {
      maxChildRuns: snapshot.limits.maxChildRuns,
      maxDepth: snapshot.limits.maxDepth,
      maxTotalTokens: snapshot.limits.maxTotalTokens,
      maxCostUsd: snapshot.limits.maxCostUsd,
    },
    childRunsStarted: snapshot.childRunsStarted,
    totalTokensUsed: snapshot.totalTokensUsed,
    costUsdUsed: snapshot.costUsdUsed,
  };
}

function sessionIdFor<TContext, TOutput>(
  request: ChildRunRequest<TContext, TOutput>,
  scope: OrchestrationScope,
): string | undefined {
  const parentSession = scope.tenantSession.sessionId;
  if (request.sessionMode === 'transfer') return parentSession;
  const prefix = [scope.tenantSession.tenantId, scope.tenantSession.namespace]
    .map(encodeURIComponent)
    .join(':');
  return `${prefix}:${parentSession ? `${encodeURIComponent(parentSession)}:` : ''}${scope.runId}`;
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
