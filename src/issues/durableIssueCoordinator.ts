import { randomUUID } from 'node:crypto';

import {
  emptyUsage,
  type AgentSpec,
  type JsonObject,
  type JsonValue,
  type OutputItem,
  type RunResult,
  type Usage,
} from '../core/index.js';
import {
  BackgroundChildManager,
  type DurableChildHandle,
  type DurableChildRecord,
  type DurableChildStore,
} from '../orchestration/background.js';
import { ChildRunner } from '../orchestration/childRunner.js';
import type {
  OrchestrationInput,
  OrchestrationRunOptions,
  OrchestrationRuntime,
  StoredRunResult,
} from '../orchestration/contracts.js';
import { RunTreeController } from '../orchestration/scope.js';
import { RuntimeServices } from '../runtime-v2/services.js';

export interface DurableIssueExecutionRequest {
  readonly agent: AgentSpec<JsonValue | undefined, JsonValue>;
  readonly input: OrchestrationInput;
  readonly context?: JsonValue;
  readonly options: OrchestrationRunOptions<JsonValue | undefined>;
}

export interface DurableIssueExecutionResult {
  readonly output: JsonValue;
  readonly items?: readonly OutputItem[];
  readonly usage?: Usage;
  readonly metadata?: Readonly<JsonObject>;
}

export type DurableIssueExecutor = (
  request: DurableIssueExecutionRequest,
) => Promise<DurableIssueExecutionResult>;

export interface DurableIssueCoordinatorOptions {
  readonly store: DurableChildStore;
  readonly executor: DurableIssueExecutor;
  readonly services?: RuntimeServices;
  readonly ownerId?: string;
  readonly leaseMs?: number;
  readonly now?: () => number;
}

export interface DurableIssueRunRequest {
  readonly childId?: string;
  readonly parentRunId?: string;
  readonly agent: AgentSpec<JsonValue | undefined, JsonValue>;
  readonly input: OrchestrationInput;
  readonly context?: JsonValue;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly tenantId?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
  readonly metadata?: Readonly<JsonObject>;
  readonly autoStart?: boolean;
}

/**
 * Product-facing issue dispatch adapter. It keeps a compatibility executor
 * behind the same durable child/checkpoint lifecycle used by Runtime v2.
 */
export class DurableIssueCoordinator {
  readonly services: RuntimeServices;
  private readonly tree = new RunTreeController();
  private readonly agents = new Map<string, AgentSpec<JsonValue | undefined, JsonValue>>();
  private readonly manager: BackgroundChildManager;

  constructor(options: DurableIssueCoordinatorOptions) {
    this.services = options.services ?? new RuntimeServices();
    const runtime = new IssueExecutionRuntime(this.services, options.executor);
    const runner = new ChildRunner(runtime, this.tree);
    this.manager = new BackgroundChildManager({
      runner,
      store: options.store,
      resolveAgent: agentId => this.agents.get(agentId),
      ownerId: options.ownerId,
      leaseMs: options.leaseMs,
      now: options.now,
    });
  }

  registerAgent(agent: AgentSpec<JsonValue | undefined, JsonValue>): this {
    const existing = this.agents.get(agent.id);
    if (existing && existing !== agent) {
      throw new Error(`Issue agent "${agent.id}" is already registered.`);
    }
    this.agents.set(agent.id, agent);
    return this;
  }

  async queue(request: DurableIssueRunRequest): Promise<DurableChildHandle> {
    this.registerAgent(request.agent);
    const parentRunId = request.parentRunId ?? `issue-parent:${randomUUID()}`;
    const parent = this.tree.createRoot({
      runId: parentRunId,
      signal: request.signal,
      deadline: request.deadline,
      services: this.services,
      tenantSession: {
        tenantId: request.tenantId ?? 'local',
        namespace: 'issues',
        sessionId: request.sessionId,
      },
      workspacePolicy: {
        workspaceId: request.workspaceId,
        root: request.workspaceRoot,
        access: 'read-write',
        allowedRoots: request.workspaceRoot ? [request.workspaceRoot] : [],
      },
      metadata: request.metadata,
    });
    try {
      return await this.manager.spawn({
        parent,
        agent: request.agent,
        input: request.input,
        context: request.context,
        childId: request.childId,
        metadata: request.metadata,
        effect: 'side-effect',
        failurePolicy: { mode: 'fail-fast' },
        autoStart: request.autoStart,
      });
    } finally {
      if (request.autoStart === false) this.tree.complete(parentRunId);
    }
  }

  async run(request: DurableIssueRunRequest): Promise<StoredRunResult> {
    const parentRunId = request.parentRunId ?? `issue-parent:${randomUUID()}`;
    try {
      const handle = await this.queue({ ...request, parentRunId, autoStart: true });
      return await handle.result();
    } finally {
      this.tree.complete(parentRunId);
    }
  }

  query(childId: string): Promise<DurableChildRecord> {
    return this.manager.query(childId);
  }

  async resume(childId: string): Promise<StoredRunResult> {
    const handle = await this.manager.resume(childId);
    return handle.result();
  }
}

class IssueExecutionRuntime implements OrchestrationRuntime {
  constructor(
    readonly services: RuntimeServices,
    private readonly executor: DurableIssueExecutor,
  ) {}

  async run<TContext, TOutput = string>(
    agent: AgentSpec<TContext, TOutput>,
    input: OrchestrationInput,
    options: OrchestrationRunOptions<TContext> = {},
  ): Promise<RunResult<TOutput>> {
    const startedAt = new Date().toISOString();
    const result = await this.executor({
      agent: agent as unknown as AgentSpec<JsonValue | undefined, JsonValue>,
      input,
      context: options.context as JsonValue | undefined,
      options: options as OrchestrationRunOptions<JsonValue | undefined>,
    });
    return {
      runId: options.runId ?? randomUUID(),
      agentId: agent.id,
      status: 'completed',
      output: result.output as TOutput,
      items: result.items ?? defaultItems(result.output),
      usage: result.usage ?? emptyUsage(),
      startedAt,
      completedAt: new Date().toISOString(),
      sessionId: options.sessionId,
      metadata: result.metadata ?? options.metadata ?? {},
    };
  }
}

function defaultItems(output: JsonValue): readonly OutputItem[] {
  if (typeof output !== 'string') return [];
  return [{ type: 'text', role: 'assistant', text: output }];
}
