import type {
  AgentSpec,
  InputItem,
  JsonObject,
  JsonValue,
  RunResult,
  Usage,
} from '../core/index.js';
import type { RunEventContext, TraceContext } from '../events/index.js';
import type { RuntimeServices } from '../runtime-v2/services.js';
import type { RuntimeHandoffRequest } from '../runtime-v2/agentRuntime.js';
import type { ToolEffect } from '../runtime-v2/tools.js';

export type OrchestrationInput = string | InputItem | readonly InputItem[];

export interface SecurityPolicyRef {
  readonly id: string;
  readonly version?: string;
  /** Policy attributes are data, never executable policy callbacks. */
  readonly attributes?: Readonly<JsonObject>;
}

export interface TenantSessionNamespace {
  readonly tenantId: string;
  readonly namespace: string;
  readonly sessionId?: string;
}

export interface WorkspacePolicy {
  readonly workspaceId?: string;
  readonly root?: string;
  readonly access: 'read-only' | 'read-write';
  readonly allowedRoots?: readonly string[];
}

export interface BudgetLimits {
  readonly maxChildRuns?: number;
  readonly maxDepth?: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
}

export interface BudgetSnapshot {
  readonly limits: Readonly<Required<BudgetLimits>>;
  readonly childRunsStarted: number;
  readonly totalTokensUsed: number;
  readonly costUsdUsed: number;
}

/** One shared ledger is inherited by the complete child tree. */
export interface BudgetController {
  claimChild(depth: number): void;
  recordUsage(usage: Usage): void;
  snapshot(): BudgetSnapshot;
}

export interface ConcurrencyRunOptions {
  readonly signal: AbortSignal;
  readonly key?: string;
}

/** One shared controller prevents nested fan-out from bypassing the root limit. */
export interface ConcurrencyController {
  run<T>(operation: () => Promise<T>, options: ConcurrencyRunOptions): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export interface OrchestrationScope {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly trace: RunEventContext;
  readonly signal: AbortSignal;
  /** Absolute Unix epoch boundary inherited without extension by children. */
  readonly deadline?: number;
  readonly securityPolicy: SecurityPolicyRef;
  readonly tenantSession: TenantSessionNamespace;
  readonly workspacePolicy: WorkspacePolicy;
  readonly budget: BudgetController;
  readonly concurrency: ConcurrencyController;
  /** Runtime-scoped providers, MCP clients and stores are never recreated per child. */
  readonly services: RuntimeServices;
  readonly metadata: Readonly<JsonObject>;
}

/**
 * A deliberately narrow runtime port. AgentRuntime structurally satisfies the
 * required `services` and `run` surface; adapters may consume the extra scope.
 */
export interface OrchestrationRuntime {
  readonly services: RuntimeServices;
  run<TContext, TOutput = string>(
    agent: AgentSpec<TContext, TOutput>,
    input: OrchestrationInput,
    options?: OrchestrationRunOptions<TContext>,
  ): Promise<RunResult<TOutput>>;
  /** Optional lifecycle port implemented by AgentRuntime for explicit ownership transfer. */
  beforeHandoff?<TContext, TOutput = string>(
    request: RuntimeHandoffRequest<TContext, TOutput>,
  ): Promise<readonly InputItem[]>;
}

export interface OrchestrationRunOptions<TContext = unknown> {
  readonly context?: TContext;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly workspaceId?: string;
  readonly metadata?: Readonly<JsonObject>;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly parentTrace?: TraceContext;
  /** Available to orchestration-aware adapters; legacy AgentRuntime ignores it. */
  readonly orchestration?: OrchestrationScope;
}

export type ChildFailurePolicy =
  | { readonly mode: 'fail-fast' }
  | { readonly mode: 'collect' }
  | {
      readonly mode: 'retry-safe';
      readonly maxAttempts: number;
      readonly retryWhen?: (error: unknown, attempt: number) => boolean;
    };

export interface ChildRunRequest<TContext = unknown, TOutput = string> {
  readonly parent: OrchestrationScope;
  readonly agent: AgentSpec<TContext, TOutput>;
  readonly input: OrchestrationInput;
  readonly context?: TContext;
  readonly runId?: string;
  readonly metadata?: Readonly<JsonObject>;
  readonly effect?: ToolEffect;
  readonly idempotencyKey?: string;
  readonly failurePolicy?: ChildFailurePolicy;
  /** Handoffs retain the current session; agent-tools and spawn get a child session. */
  readonly sessionMode?: 'child' | 'transfer';
}

export interface ChildRunSuccess<TOutput = string> {
  readonly status: 'completed';
  readonly attempts: number;
  readonly scope: OrchestrationScope;
  readonly result: RunResult<TOutput>;
}

export interface SerializedChildError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface ChildRunFailure {
  readonly status: 'failed';
  readonly attempts: number;
  readonly scope: OrchestrationScope;
  readonly error: SerializedChildError;
}

export type ChildRunOutcome<TOutput = string> = ChildRunSuccess<TOutput> | ChildRunFailure;

export class ChildRunError extends Error {
  constructor(
    message: string,
    readonly childRunId: string,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChildRunError';
  }
}

export interface ConversationOwner {
  readonly agentId: string;
  readonly runId: string;
}

export interface ConversationState {
  readonly owner: ConversationOwner;
  readonly items: readonly InputItem[];
}

export interface PersistedScope {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly trace: RunEventContext;
  readonly deadline?: number;
  readonly securityPolicy: SecurityPolicyRef;
  readonly tenantSession: TenantSessionNamespace;
  readonly workspacePolicy: WorkspacePolicy;
  readonly budget: BudgetSnapshot;
  readonly metadata: Readonly<JsonObject>;
}

export interface StoredRunResult {
  readonly runId: string;
  readonly agentId: string;
  readonly status: RunResult<JsonValue>['status'];
  readonly output: JsonValue;
  readonly items: RunResult<JsonValue>['items'];
  readonly usage: Usage;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sessionId?: string;
  readonly metadata?: Readonly<JsonObject>;
}
