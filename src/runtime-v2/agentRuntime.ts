import { randomUUID } from 'node:crypto';

import {
  RunError,
  UsageAccumulator,
  assertJsonValue,
  emptyUsage,
  type AgentSpec,
  type InputItem,
  type JsonObject,
  type JsonValue,
  type ModelRef,
  type OutputItem,
  type RunContext,
  type RunLimits,
  type RunResult,
  type ToolCallItem,
} from '../core/index.js';
import {
  EventDispatcher,
  RunEventSequencer,
  SensitiveDataRedactionProcessor,
  createRootTraceContext,
  type EventProcessor,
  type EventSink,
  type RunEvent,
  type RunEventContext,
  type TraceContext,
} from '../events/index.js';
import { ModelRegistry } from '../providers-v2/registry.js';
import type {
  ModelCallContext,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
} from '../providers-v2/types.js';
import { AsyncQueue } from '../runtime/asyncQueue.js';
import { SessionTurnCoordinator } from '../runtime/sessionTurnCoordinator.js';
import {
  MiddlewarePipeline,
  MiddlewareRegistry,
  MiddlewareStage,
  buildMiddlewarePipeline,
  type AnyMiddlewareDefinition,
  type MiddlewareDeadline,
  type MiddlewareInvocationContext,
} from './middleware/index.js';
import { RuntimeServices } from './services.js';
import type {
  InterruptionDecision,
  RunCheckpointStore,
  RuntimeSessionStore,
  SerializedPendingTool,
  SerializedRunState,
} from './state.js';
import {
  ToolExecutionError,
  ToolInterruptionRequiredError,
  ToolRegistry,
  ToolRunner,
  toolEffect,
  type ToolOutput,
  type ToolPolicy,
} from './tools.js';

export type AgentInput = string | InputItem | readonly InputItem[];

export interface RunOptions<TContext = unknown> {
  readonly context?: TContext;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly expectedSessionRevision?: string;
  readonly workspaceId?: string;
  readonly metadata?: Readonly<JsonObject>;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly parentTrace?: TraceContext;
}

export interface AgentRuntimeOptions<TContext = unknown> {
  readonly models: ModelRegistry;
  /** Maximum number of top-level runs that may execute concurrently. */
  readonly maxConcurrentRuns?: number;
  readonly defaultModel?: ModelRef;
  readonly tools?: ToolRegistry;
  readonly toolPolicy?: ToolPolicy<TContext>;
  readonly services?: RuntimeServices;
  readonly middleware?: MiddlewarePipeline | Iterable<AnyMiddlewareDefinition>;
  readonly middlewareRegistry?: MiddlewareRegistry;
  readonly eventProcessors?: readonly EventProcessor[];
  readonly eventSinks?: readonly EventSink[];
  readonly eventFailureMode?: 'throw' | 'isolate';
  readonly checkpointStore?: RunCheckpointStore;
  readonly defaultLimits?: Partial<RunLimits>;
  readonly agents?: readonly AgentSpec<any, any>[];
}

export interface RuntimeMiddlewareContext<TContext = unknown>
  extends MiddlewareInvocationContext {
  readonly runtime: AgentRuntime;
  readonly services: RuntimeServices;
  readonly agent: AgentSpec<TContext, unknown>;
  readonly run: RunContext<TContext>;
  readonly state: SerializedRunState;
  readonly input?: readonly InputItem[];
  readonly modelRequest?: ModelRequest;
  readonly modelResponse?: ModelResponse;
  readonly toolCall?: ToolCallItem;
  readonly toolOutput?: ToolOutput<unknown>;
  readonly result?: RunResult<unknown>;
}

/** Input to the explicit orchestration handoff lifecycle boundary. */
export interface RuntimeHandoffRequest<TContext = unknown, TOutput = string> {
  readonly sourceAgentId: string;
  readonly targetAgent: AgentSpec<TContext, TOutput>;
  readonly handoffId: string;
  readonly input: readonly InputItem[];
  readonly parentRunId: string;
  readonly signal: AbortSignal;
  /** Absolute Unix epoch deadline inherited from the parent orchestration scope. */
  readonly deadline?: number;
  readonly metadata?: Readonly<JsonObject>;
}

/** Context exposed only at the `beforeHandoff` stage. */
export interface RuntimeHandoffMiddlewareContext<TContext = unknown, TOutput = string>
  extends MiddlewareInvocationContext {
  readonly runtime: AgentRuntime;
  readonly services: RuntimeServices;
  readonly sourceAgent?: AgentSpec<unknown, unknown>;
  readonly targetAgent: AgentSpec<TContext, TOutput>;
  readonly sourceAgentId: string;
  readonly parentRunId: string;
  readonly handoffId: string;
  readonly input: readonly InputItem[];
  readonly metadata?: Readonly<JsonObject>;
}

/** Raised when ordinary middleware attempts to replace a reserved runtime boundary. */
export class MiddlewareInvariantViolationError extends RunError {
  readonly stage: MiddlewareStage;

  constructor(stage: MiddlewareStage, runId: string | undefined, message: string, cause?: unknown) {
    super(message, {
      code: 'MIDDLEWARE_INVARIANT_VIOLATION',
      runId,
      phase: stage === MiddlewareStage.WrapToolCall
        ? 'tool_call'
        : stage === MiddlewareStage.BeforeHandoff
          ? 'handoff'
          : 'model_call',
      cause,
      details: { stage },
    });
    this.stage = stage;
  }
}

export interface RunHandle<TOutput = string> extends AsyncIterable<RunEvent> {
  readonly runId: string;
  readonly result: Promise<RunResult<TOutput>>;
  cancel(reason?: string): void;
  snapshot(): Promise<SerializedRunState>;
}

interface ExecutionObserver {
  emit(event: RunEvent): Promise<void>;
  update(state: SerializedRunState): void;
  readonly streamModel?: boolean;
}

interface ExecutionSeed<TContext, TOutput> {
  agent: AgentSpec<TContext, TOutput>;
  input: readonly InputItem[];
  options: RunOptions<TContext>;
  state: SerializedRunState;
  decisions?: readonly InterruptionDecision[];
}

const DEFAULT_LIMITS: RunLimits = Object.freeze({
  maxTurns: 32,
  runDeadlineMs: 15 * 60_000,
  modelCallTimeoutMs: 120_000,
  toolTimeoutMs: 120_000,
  hookTimeoutMs: 30_000,
  maxParallelTools: 10,
  maxSubagentDepth: 1,
  maxSubagentFanout: 8,
  streamBufferSize: 256,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 64_000,
  maxTotalTokens: 1_000_000,
  maxCostUsd: 100,
});

const DEFAULT_MAX_CONCURRENT_RUNS = 64;

export class AgentRuntime {
  private readonly models: ModelRegistry;
  private readonly defaultModel?: ModelRef;
  readonly tools: ToolRegistry;
  private readonly toolRunner: ToolRunner<any>;
  private readonly hasToolPolicy: boolean;
  readonly services: RuntimeServices;
  readonly middleware: MiddlewarePipeline;
  readonly middlewareRegistry: MiddlewareRegistry;
  private readonly events: EventDispatcher;
  private readonly checkpointStore?: RunCheckpointStore;
  private readonly defaultLimits: RunLimits;
  private readonly runConcurrency: RunConcurrencyGate;
  private readonly agents = new Map<string, AgentSpec<any, any>>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeSettlements = new Map<string, Promise<void>>();
  private readonly agentPipelines = new WeakMap<object, MiddlewarePipeline>();
  private readonly sessionTurns = new SessionTurnCoordinator();
  private closed = false;

  constructor(options: AgentRuntimeOptions<any>) {
    this.models = options.models;
    this.runConcurrency = new RunConcurrencyGate(
      options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    );
    this.defaultModel = options.defaultModel;
    this.tools = options.tools ?? new ToolRegistry();
    this.toolRunner = new ToolRunner({ registry: this.tools, policy: options.toolPolicy });
    this.hasToolPolicy = options.toolPolicy !== undefined;
    this.services = options.services ?? new RuntimeServices();
    this.middleware = options.middleware instanceof MiddlewarePipeline
      ? options.middleware
      : buildMiddlewarePipeline(options.middleware ?? []);
    this.middlewareRegistry = options.middlewareRegistry ?? new MiddlewareRegistry();
    this.events = new EventDispatcher({
      processors: [new SensitiveDataRedactionProcessor(), ...(options.eventProcessors ?? [])],
      sinks: options.eventSinks,
      failureMode: options.eventFailureMode,
    });
    this.checkpointStore = options.checkpointStore;
    this.defaultLimits = resolveLimits(DEFAULT_LIMITS, options.defaultLimits);
    for (const agent of options.agents ?? []) this.registerAgent(agent);
  }

  registerAgent<TContext, TOutput>(agent: AgentSpec<TContext, TOutput>): this {
    assertAgentSpec(agent);
    const current = this.agents.get(agent.id);
    if (current && current !== agent) throw new Error(`Agent "${agent.id}" is already registered.`);
    this.agents.set(agent.id, agent);
    return this;
  }

  async run<TContext, TOutput = string>(
    agent: AgentSpec<TContext, TOutput>,
    input: AgentInput,
    options: RunOptions<TContext> = {},
  ): Promise<RunResult<TOutput>> {
    this.assertOpen();
    const seed = this.createSeed(agent, input, options);
    const controller = this.claimRun(seed.state.runId, options.signal);
    let current = seed.state;
    const execution = this.executeWithSessionLock(seed, controller.signal, {
      emit: event => this.events.dispatch(event).then(() => undefined),
      update: state => { current = state; },
    });
    this.trackSettlement(seed.state.runId, execution);
    try {
      return await execution;
    } finally {
      this.releaseRun(seed.state.runId, controller);
      void current;
    }
  }

  stream<TContext, TOutput = string>(
    agent: AgentSpec<TContext, TOutput>,
    input: AgentInput,
    options: RunOptions<TContext> = {},
  ): RunHandle<TOutput> {
    this.assertOpen();
    const seed = this.createSeed(agent, input, options);
    const limits = resolveLimits(this.defaultLimits, agent.limits);
    const queue = createEventQueue(limits.streamBufferSize);
    const controller = this.claimRun(seed.state.runId, options.signal);
    let current = seed.state;

    const result = Promise.resolve().then(() => this.executeWithSessionLock(seed, controller.signal, {
      emit: async event => {
        const processed = await this.events.dispatch(event);
        if (processed) queue.push(processed);
      },
      update: state => { current = state; },
      streamModel: true,
    })).finally(() => {
      queue.close();
      this.releaseRun(seed.state.runId, controller);
    });
    void result.catch(() => undefined);
    this.trackSettlement(seed.state.runId, result);

    return new RuntimeRunHandle(
      seed.state.runId,
      result,
      queue,
      controller,
      () => cloneState(current),
    );
  }

  resume<TOutput = string>(
    state: SerializedRunState,
    decisions: readonly InterruptionDecision[] = [],
  ): RunHandle<TOutput> {
    this.assertOpen();
    validateSerializedState(state);
    const agent = this.agents.get(state.agentId);
    if (!agent) {
      throw new RunError(`Cannot resume run ${state.runId}: agent "${state.agentId}" is not registered.`, {
        code: 'AGENT_NOT_REGISTERED',
        runId: state.runId,
        phase: 'runtime',
      });
    }
    if (state.agentConfigDigest !== agentDigest(agent)) {
      throw new RunError(`Cannot resume run ${state.runId}: agent configuration changed.`, {
        code: 'AGENT_CONFIG_MISMATCH',
        runId: state.runId,
        phase: 'runtime',
      });
    }
    const input = cloneItems(state.input);
    const options: RunOptions = {
      runId: state.runId,
      sessionId: state.sessionId,
      tenantId: state.tenantId,
      expectedSessionRevision: state.expectedSessionRevision,
      workspaceId: state.workspaceId,
      metadata: state.metadata,
    };
    const seed: ExecutionSeed<any, TOutput> = {
      agent: agent as AgentSpec<any, TOutput>,
      input,
      options,
      state: cloneState({ ...state, status: 'running' }),
      decisions,
    };
    const limits = resolveLimits(this.defaultLimits, agent.limits);
    const queue = createEventQueue(limits.streamBufferSize);
    const controller = this.claimRun(state.runId);
    let current = seed.state;
    const result = Promise.resolve().then(() => this.executeWithSessionLock(seed, controller.signal, {
      emit: async event => {
        const processed = await this.events.dispatch(event);
        if (processed) queue.push(processed);
      },
      update: next => { current = next; },
      streamModel: true,
    })).finally(() => {
      queue.close();
      this.releaseRun(state.runId, controller);
    }) as Promise<RunResult<TOutput>>;
    void result.catch(() => undefined);
    this.trackSettlement(state.runId, result);
    return new RuntimeRunHandle(state.runId, result, queue, controller, () => cloneState(current));
  }

  inspectMiddleware(agent?: AgentSpec<any, any>): string {
    return (agent ? this.pipelineFor(agent) : this.middleware).format();
  }

  /**
   * Run the explicit handoff lifecycle stage before orchestration transfers
   * conversation ownership. This keeps orchestration host-driven while making
   * the runtime middleware contract effective on the real handoff path.
   */
  async beforeHandoff<TContext, TOutput = string>(
    request: RuntimeHandoffRequest<TContext, TOutput>,
  ): Promise<readonly InputItem[]> {
    this.assertOpen();
    if (!request.sourceAgentId.trim()) throw new TypeError('Handoff sourceAgentId must not be empty.');
    if (!request.handoffId.trim()) throw new TypeError('Handoff id must not be empty.');
    if (!request.parentRunId.trim()) throw new TypeError('Handoff parentRunId must not be empty.');
    assertAgentSpec(request.targetAgent);
    request.signal.throwIfAborted();

    const sourceAgent = this.agents.get(request.sourceAgentId);
    const pipeline = sourceAgent ? this.pipelineFor(sourceAgent) : this.middleware;
    const deadline = request.deadline === undefined
      ? undefined
      : { expiresAt: request.deadline, scope: `handoff:${request.handoffId}` };
    const context: RuntimeHandoffMiddlewareContext<TContext, TOutput> = {
      runtime: this,
      services: this.services,
      sourceAgent,
      targetAgent: request.targetAgent,
      sourceAgentId: request.sourceAgentId,
      parentRunId: request.parentRunId,
      handoffId: request.handoffId,
      input: cloneItems(request.input),
      metadata: request.metadata,
      signal: request.signal,
      deadline,
    };
    const prepared = await pipeline.runWithErrorStage(
      MiddlewareStage.BeforeHandoff,
      context,
      stageContext => stageContext.input,
    );
    if (!Array.isArray(prepared)) {
      throw new MiddlewareInvariantViolationError(
        MiddlewareStage.BeforeHandoff,
        request.parentRunId,
        'beforeHandoff middleware must return canonical input items.',
      );
    }
    return cloneItems(prepared);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeRuns.values()) {
      controller.abort(abortError('AgentRuntime closed.'));
    }
    await Promise.allSettled([...this.activeSettlements.values()]);
    this.activeRuns.clear();
    const results = await Promise.allSettled([this.events.close(), this.services.close()]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'AgentRuntime close failed.');
  }

  private createSeed<TContext, TOutput>(
    agent: AgentSpec<TContext, TOutput>,
    input: AgentInput,
    options: RunOptions<TContext>,
  ): ExecutionSeed<TContext, TOutput> {
    assertAgentSpec(agent);
    this.registerAgent(agent);
    const runId = options.runId ?? randomUUID();
    const trace = options.parentTrace && options.parentRunId
      ? childTrace(runId, options.parentRunId, options.parentTrace)
      : createRootTraceContext(runId);
    const startedAt = new Date().toISOString();
    const limits = resolveLimits(this.defaultLimits, agent.limits);
    const normalizedInput = normalizeInput(input);
    return {
      agent,
      input: normalizedInput,
      options,
      state: {
        schemaVersion: 1,
        runId,
        agentId: agent.id,
        agentConfigDigest: agentDigest(agent),
        status: 'running',
        trace,
        startedAt,
        deadlineAt: new Date(Date.now() + limits.runDeadlineMs).toISOString(),
        turn: 0,
        input: cloneItems(normalizedInput),
        transcript: cloneItems(normalizedInput),
        generatedItems: [],
        usage: emptyUsage(),
        sessionId: options.sessionId,
        tenantId: options.tenantId,
        expectedSessionRevision: options.expectedSessionRevision,
        workspaceId: options.workspaceId,
        childRunIds: [],
        metadata: options.metadata ?? {},
      },
    };
  }

  private async execute<TContext, TOutput>(
    seed: ExecutionSeed<TContext, TOutput>,
    parentSignal: AbortSignal,
    observer: ExecutionObserver,
  ): Promise<RunResult<TOutput>> {
    const { agent, options } = seed;
    const pipeline = this.pipelineFor(agent);
    const limits = resolveLimits(this.defaultLimits, agent.limits);
    const persistedDeadline = seed.state.deadlineAt === undefined
      ? undefined
      : Date.parse(seed.state.deadlineAt);
    if (persistedDeadline !== undefined && !Number.isFinite(persistedDeadline)) {
      throw new RunError('Serialized run deadline is invalid.', {
        code: 'RUN_DEADLINE_INVALID', runId: seed.state.runId, phase: 'runtime',
      });
    }
    const runTimeoutMs = persistedDeadline === undefined
      ? limits.runDeadlineMs
      : Math.max(0, persistedDeadline - Date.now());
    const boundary = createBoundary(parentSignal, runTimeoutMs, 'Run deadline exceeded.');
    const signal = boundary.signal;
    const usage = new UsageAccumulator(seed.state.usage);
    let state = cloneState(seed.state);
    let lastResponse: ModelResponse | undefined;
    const sequencer = new RunEventSequencer(state.trace);
    const runContext: RunContext<TContext> = {
      runId: state.runId,
      agentId: agent.id,
      context: options.context as TContext,
      signal,
      startedAt: state.startedAt,
      deadlineAt: state.deadlineAt,
      sessionId: state.sessionId,
      metadata: state.metadata,
      usage,
    };
    const deadline: MiddlewareDeadline = {
      expiresAt: Date.parse(state.deadlineAt ?? new Date(Date.now() + limits.runDeadlineMs).toISOString()),
      scope: `run:${state.runId}`,
    };
    const emit = async (type: string, data: unknown) => {
      await observer.emit(sequencer.next(type, data));
    };
    const update = async (patch: Partial<SerializedRunState> = {}) => {
      state = cloneState({ ...state, ...patch, usage: usage.snapshot() });
      observer.update(state);
      await this.checkpointStore?.save(state);
    };
    const middlewareContext = (extra: Partial<RuntimeMiddlewareContext<TContext>> = {}) => ({
      runtime: this,
      services: this.services,
      agent: agent as AgentSpec<TContext, unknown>,
      run: runContext,
      state,
      signal,
      deadline,
      ...extra,
    });

    await emit(seed.decisions ? 'run.resumed' : 'run.started', { agentId: agent.id });
    try {
      let preparedInput = await pipeline.runWithErrorStage(
        MiddlewareStage.PrepareInput,
        middlewareContext({ input: seed.input }),
        context => Promise.resolve(context.input ?? seed.input),
      );
      if (state.turn === 0 && state.sessionId) {
        const sessionStore = await this.resolveSessionStore(state.runId);
        const loaded = await sessionStore.load({
          tenantId: state.tenantId ?? 'default',
          sessionId: state.sessionId,
        });
        preparedInput = [...loaded.items, ...preparedInput];
        await update({ expectedSessionRevision: loaded.revision });
        await emit('session.loaded', {
          sessionId: state.sessionId,
          revision: loaded.revision,
          itemCount: loaded.items.length,
        });
      }
      if (state.turn > 0 && state.sessionId) {
        const sessionStore = await this.resolveSessionStore(state.runId);
        const current = await sessionStore.load({
          tenantId: state.tenantId ?? 'default',
          sessionId: state.sessionId,
        });
        if (state.expectedSessionRevision !== current.revision) {
          throw new RunError(
            `Session "${state.sessionId}" changed while run "${state.runId}" was interrupted.`,
            {
              code: 'SESSION_REVISION_CONFLICT',
              runId: state.runId,
              phase: 'runtime',
              details: {
                expectedRevision: state.expectedSessionRevision ?? null,
                actualRevision: current.revision,
              },
            },
          );
        }
      }
      const instructions = await resolveInstructions(agent, runContext);
      if (instructions) {
        preparedInput = [
          { type: 'text', role: 'system', text: instructions },
          ...preparedInput,
        ];
      }

      if (state.turn === 0 && state.generatedItems.length === 0) {
        await runInputGuardrails(agent, runContext, preparedInput);
        await update({ transcript: cloneItems(preparedInput) });
        await pipeline.runWithErrorStage(
          MiddlewareStage.BeforeRun,
          middlewareContext({ input: preparedInput }),
          () => undefined,
        );
      }

      const pendingBeforeResume = state.pendingTool;
      const resumed = await this.resumePendingTool(seed.decisions ?? [], state, runContext, update, emit);
      if (resumed) state = resumed;
      const approval = pendingBeforeResume?.interruptionId
        ? seed.decisions?.find(item => item.interruptionId === pendingBeforeResume.interruptionId)
        : undefined;
      if (state.pendingTool?.status === 'prepared' && approval?.outcome === 'approve') {
        await this.executeToolCall(
          state.pendingTool.call,
          state,
          runContext,
          limits,
          pipeline,
          middlewareContext,
          update,
          emit,
          approval,
        );
        await update({ pendingTool: undefined });
      }

      while (state.turn < limits.maxTurns) {
        signal.throwIfAborted();
        const model = agent.model ?? this.defaultModel;
        if (!model) {
          throw new RunError(`Agent "${agent.id}" does not declare a model and no default model exists.`, {
            code: 'MODEL_REQUIRED', runId: state.runId, phase: 'model_call',
          });
        }
        const request = this.createModelRequest(agent, model, state.transcript, limits);
        await emit('model.requested', { turn: state.turn + 1, model });
        const modelBoundary = createBoundary(signal, limits.modelCallTimeoutMs, 'Model call deadline exceeded.');
        let response: ModelResponse;
        let modelTerminalCompleted = false;
        try {
          response = await pipeline.runWithErrorStage(
            MiddlewareStage.WrapModelCall,
            { ...middlewareContext({ modelRequest: request }), signal: modelBoundary.signal },
            async () => {
              const value = await raceWithSignal(
                this.callModel(request, {
                runId: state.runId,
                traceId: state.trace.traceId,
                spanId: state.trace.spanId,
                signal: modelBoundary.signal,
                deadline: Math.min(deadline.expiresAt, Date.now() + limits.modelCallTimeoutMs),
                }, observer, emit),
                modelBoundary.signal,
              );
              modelTerminalCompleted = true;
              return value;
            },
          );
        } finally {
          modelBoundary.dispose();
        }
        if (!modelTerminalCompleted) {
          throw new MiddlewareInvariantViolationError(
            MiddlewareStage.WrapModelCall,
            state.runId,
            'wrapModelCall middleware cannot replace the provider/capability boundary; call next().',
          );
        }
        response = validateModelResponse(response, state.runId);
        usage.add(response.usage.requests > 0 ? response.usage : { ...response.usage, requests: 1 });
        enforceUsageLimits(usage, limits, state.runId);
        response = await pipeline.runWithErrorStage(
          MiddlewareStage.AfterModelResponse,
          middlewareContext({ modelRequest: request, modelResponse: response }),
          context => context.modelResponse as ModelResponse,
        );
        response = validateModelResponse(response, state.runId);
        lastResponse = response;
        const nextGenerated = [...state.generatedItems, ...response.output];
        const nextTranscript = [...state.transcript, ...response.output];
        await update({
          turn: state.turn + 1,
          generatedItems: nextGenerated,
          transcript: nextTranscript,
        });
        await emit('model.completed', {
          turn: state.turn,
          finishReason: response.finishReason,
          usage: response.usage,
        });

        const toolCalls = response.output.filter(
          (item): item is ToolCallItem => item.type === 'tool_call',
        );
        if (toolCalls.length === 0) break;

        for (let index = 0; index < toolCalls.length;) {
          const call = toolCalls[index]!;
          if (this.canParallelizeReadTool(call) && limits.maxParallelTools > 1) {
            const batch: ToolCallItem[] = [];
            while (
              index < toolCalls.length
              && batch.length < limits.maxParallelTools
              && this.canParallelizeReadTool(toolCalls[index]!)
            ) {
              batch.push(toolCalls[index]!);
              index += 1;
            }
            const results = await Promise.all(batch.map(item => this.executeReadToolCall(
              item,
              state,
              runContext,
              limits,
              pipeline,
              middlewareContext,
              emit,
            )));
            await update({
              generatedItems: [...state.generatedItems, ...results],
              transcript: [...state.transcript, ...results],
            });
            continue;
          }
          await this.executeToolCall(call, state, runContext, limits, pipeline, middlewareContext, update, emit);
          await update({ pendingTool: undefined });
          index += 1;
        }
        await pipeline.runWithErrorStage(
          MiddlewareStage.AfterTurn,
          middlewareContext(),
          () => undefined,
        );
      }

      if (!lastResponse && state.status !== 'running') {
        return this.interruptedResult(agent, state);
      }
      if (!lastResponse) {
        throw new RunError('Run has no model response.', {
          code: 'EMPTY_MODEL_RESPONSE', runId: state.runId, phase: 'finalize_output',
        });
      }
      if (state.turn >= limits.maxTurns && lastResponse.output.some(item => item.type === 'tool_call')) {
        throw new RunError(`Run exceeded maxTurns=${limits.maxTurns}.`, {
          code: 'MAX_TURNS_EXCEEDED', runId: state.runId, phase: 'runtime',
        });
      }

      let output = await pipeline.runWithErrorStage(
        MiddlewareStage.FinalizeOutput,
        middlewareContext({ modelResponse: lastResponse }),
        () => finalizeOutput(agent, lastResponse as ModelResponse),
      );
      await runOutputGuardrails(agent, runContext, output);
      if (state.sessionId) {
        const sessionStore = await this.resolveSessionStore(state.runId);
        const committed = await sessionStore.append({
          tenantId: state.tenantId ?? 'default',
          sessionId: state.sessionId,
          items: [...state.input, ...state.generatedItems],
          expectedRevision: state.expectedSessionRevision ?? '0',
        });
        await update({ expectedSessionRevision: committed.revision });
        await emit('session.committed', {
          sessionId: state.sessionId,
          revision: committed.revision,
        });
      }
      const completedAt = new Date().toISOString();
      let result: RunResult<TOutput> = {
        runId: state.runId,
        agentId: agent.id,
        status: 'completed',
        output,
        items: state.generatedItems,
        usage: usage.snapshot(),
        startedAt: state.startedAt,
        completedAt,
        sessionId: state.sessionId,
        metadata: state.metadata,
      };
      result = await pipeline.runWithErrorStage(
        MiddlewareStage.AfterRun,
        middlewareContext({ result }),
        context => context.result as RunResult<TOutput>,
      );
      await update({ status: 'completed' });
      await emit('run.completed', { status: result.status, usage: result.usage });
      await this.checkpointStore?.delete(state.runId);
      return result;
    } catch (error) {
      if (error instanceof ToolInterruptionRequiredError) {
        await update({ status: 'interrupted' });
        await emit('run.interrupted', {
          interruptionId: error.decision.interruptionId,
          reason: error.decision.reason,
        });
        return this.interruptedResult(agent, state);
      }
      if (signal.aborted) {
        await update({ status: 'cancelled' });
        await emit('run.cancelled', { reason: errorMessage(signal.reason ?? error) });
        return {
          ...this.interruptedResult(agent, state),
          status: 'cancelled',
        };
      }
      await update({ status: 'failed' });
      await emit('run.failed', { error: serializeError(error) });
      throw error;
    } finally {
      boundary.dispose();
    }
  }

  private createModelRequest<TContext, TOutput>(
    agent: AgentSpec<TContext, TOutput>,
    model: ModelRef,
    input: readonly InputItem[],
    limits: RunLimits,
  ): ModelRequest {
    const tools: ModelToolDefinition[] = [];
    for (const ref of agent.tools ?? []) {
      const name = typeof ref === 'string' ? ref : ref.id;
      const tool = this.tools.resolve(name);
      if (!tool) throw new RunError(`Agent "${agent.id}" references unknown tool "${name}".`, {
        code: 'TOOL_NOT_FOUND', phase: 'before_run',
      });
      tools.push({
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        inputSchema: (tool.descriptor.input.jsonSchema ?? {}) as JsonObject,
      });
    }
    return {
      model,
      input,
      tools: tools.length > 0 ? tools : undefined,
      toolPolicy: tools.length > 0 ? 'auto' : 'none',
      outputSchema: agent.output
        ? {
            name: agent.output.name,
            schema: agent.output.schema,
            description: agent.output.description,
            strict: agent.output.strict,
          }
        : undefined,
      maxOutputTokens: Math.min(limits.maxOutputTokens, 64_000),
    };
  }

  private async callModel(
    request: ModelRequest,
    context: ModelCallContext,
    observer: ExecutionObserver,
    emit: (type: string, data: unknown) => Promise<void>,
  ): Promise<ModelResponse> {
    if (!observer.streamModel) return this.models.generate(request, context);
    const stream = this.models.stream(request, context);
    const onAbort = () => stream.cancel(context.signal?.reason);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const event of stream) {
        await emitModelStreamEvent(event, emit);
      }
      return await stream.finalResponse();
    } finally {
      context.signal?.removeEventListener('abort', onAbort);
      if (context.signal?.aborted) stream.cancel(context.signal.reason);
    }
  }

  private async executeToolCall<TContext>(
    call: ToolCallItem,
    state: SerializedRunState,
    runContext: RunContext<TContext>,
    limits: RunLimits,
    pipeline: MiddlewarePipeline,
    middlewareContext: (extra?: Partial<RuntimeMiddlewareContext<TContext>>) => RuntimeMiddlewareContext<TContext>,
    update: (patch?: Partial<SerializedRunState>) => Promise<void>,
    emit: (type: string, data: unknown) => Promise<void>,
    approval?: Extract<InterruptionDecision, { outcome: 'approve' }>,
  ): Promise<void> {
    const definition = this.tools.resolve(call.name);
    const effect = definition ? toolEffect(definition.descriptor) : 'side-effect';
    const pending: SerializedPendingTool = { call, effect, status: 'prepared' };
    await update({ pendingTool: pending });
    await pipeline.runWithErrorStage(
      MiddlewareStage.BeforeToolCall,
      middlewareContext({ toolCall: call }),
      () => undefined,
    );
    await update({ pendingTool: { ...pending, status: 'started' } });
    await emit('tool.started', { callId: call.id, name: call.name, effect });

    try {
      let toolTerminalCompleted = false;
      let toolTerminalOutput: ToolOutput<unknown> | undefined;
      const output = await pipeline.runWithErrorStage(
        MiddlewareStage.WrapToolCall,
        middlewareContext({ toolCall: call }),
        async () => {
          const value = await this.toolRunner.execute(call.name, call.input, {
            runId: state.runId,
            callId: call.id,
            signal: runContext.signal,
            deadline: Date.now() + limits.toolTimeoutMs,
            context: runContext.context,
            idempotencyKey: effect === 'idempotent-write' ? `${state.runId}:${call.id}` : undefined,
            approval: approval
              ? {
                  interruptionId: approval.interruptionId,
                  outcome: 'approve',
                  metadata: approval.metadata,
                }
              : undefined,
            workspaceId: state.workspaceId,
            metadata: state.metadata,
          });
          toolTerminalOutput = freezeToolOutput(
            validateToolTerminalOutput(definition, value, call, state.runId),
          );
          toolTerminalCompleted = true;
          return toolTerminalOutput;
        },
      );
      if (!toolTerminalCompleted) {
        throw new MiddlewareInvariantViolationError(
          MiddlewareStage.WrapToolCall,
          state.runId,
          'wrapToolCall middleware cannot replace ToolRunner policy/schema validation; call next().',
        );
      }
      if (output !== toolTerminalOutput) {
        throw new MiddlewareInvariantViolationError(
          MiddlewareStage.WrapToolCall,
          state.runId,
          'wrapToolCall middleware must return the validated ToolRunner output unchanged.',
        );
      }
      const validatedOutput = output;
      const normalizedOutput = toJsonValue(validatedOutput.value, call.name);
      const result: OutputItem = {
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        status: 'success',
        output: normalizedOutput,
      };
      await pipeline.runWithErrorStage(
        MiddlewareStage.AfterToolCall,
        middlewareContext({ toolCall: call, toolOutput: validatedOutput }),
        () => undefined,
      );
      await update({
        pendingTool: { ...pending, status: 'committed', result },
        generatedItems: [...state.generatedItems, result],
        transcript: [...state.transcript, result],
      });
      await emit('tool.completed', {
        callId: call.id,
        name: call.name,
        artifacts: validatedOutput.artifacts,
      });
    } catch (error) {
      if (error instanceof ToolInterruptionRequiredError) {
        await update({
          pendingTool: {
            ...pending,
            status: 'awaiting_approval',
            interruptionId: error.decision.interruptionId,
          },
        });
        throw error;
      }
      if (!(error instanceof ToolExecutionError)) throw error;
      const result: OutputItem = {
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        status: 'error',
        output: {
          kind: error.failure.kind,
          message: this.toolRunner.formatFailure(error),
          retryable: error.failure.retryable,
        },
      };
      await update({
        pendingTool: { ...pending, status: 'committed', result },
        generatedItems: [...state.generatedItems, result],
        transcript: [...state.transcript, result],
      });
      await emit('tool.failed', { callId: call.id, name: call.name, failure: error.failure });
    }
  }

  private canParallelizeReadTool(call: ToolCallItem): boolean {
    if (this.hasToolPolicy) return false;
    const tool = this.tools.resolve(call.name);
    return tool !== undefined
      && toolEffect(tool.descriptor) === 'read'
      && tool.descriptor.behavior?.requiresApproval !== true;
  }

  private async executeReadToolCall<TContext>(
    call: ToolCallItem,
    state: SerializedRunState,
    runContext: RunContext<TContext>,
    limits: RunLimits,
    pipeline: MiddlewarePipeline,
    middlewareContext: (extra?: Partial<RuntimeMiddlewareContext<TContext>>) => RuntimeMiddlewareContext<TContext>,
    emit: (type: string, data: unknown) => Promise<void>,
  ): Promise<OutputItem> {
    const definition = this.tools.resolve(call.name);
    await pipeline.runWithErrorStage(
      MiddlewareStage.BeforeToolCall,
      middlewareContext({ toolCall: call }),
      () => undefined,
    );
    await emit('tool.started', { callId: call.id, name: call.name, effect: 'read' });
    try {
      let toolTerminalCompleted = false;
      let toolTerminalOutput: ToolOutput<unknown> | undefined;
      const output = await pipeline.runWithErrorStage(
        MiddlewareStage.WrapToolCall,
        middlewareContext({ toolCall: call }),
        async () => {
          const value = await this.toolRunner.execute(call.name, call.input, {
            runId: state.runId,
            callId: call.id,
            signal: runContext.signal,
            deadline: Date.now() + limits.toolTimeoutMs,
            context: runContext.context,
            workspaceId: state.workspaceId,
            metadata: state.metadata,
          });
          toolTerminalOutput = freezeToolOutput(
            validateToolTerminalOutput(definition, value, call, state.runId),
          );
          toolTerminalCompleted = true;
          return toolTerminalOutput;
        },
      );
      if (!toolTerminalCompleted) {
        throw new MiddlewareInvariantViolationError(
          MiddlewareStage.WrapToolCall,
          state.runId,
          'wrapToolCall middleware cannot replace ToolRunner schema validation; call next().',
        );
      }
      if (output !== toolTerminalOutput) {
        throw new MiddlewareInvariantViolationError(
          MiddlewareStage.WrapToolCall,
          state.runId,
          'wrapToolCall middleware must return the validated ToolRunner output unchanged.',
        );
      }
      const validatedOutput = output;
      await pipeline.runWithErrorStage(
        MiddlewareStage.AfterToolCall,
        middlewareContext({ toolCall: call, toolOutput: validatedOutput }),
        () => undefined,
      );
      const result: OutputItem = {
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        status: 'success',
        output: toJsonValue(validatedOutput.value, call.name),
      };
      await emit('tool.completed', {
        callId: call.id,
        name: call.name,
        artifacts: validatedOutput.artifacts,
      });
      return result;
    } catch (error) {
      if (!(error instanceof ToolExecutionError)) throw error;
      const result = toolFailureResult(call, error, this.toolRunner.formatFailure(error));
      await emit('tool.failed', { callId: call.id, name: call.name, failure: error.failure });
      return result;
    }
  }

  private async resumePendingTool<TContext>(
    decisions: readonly InterruptionDecision[],
    state: SerializedRunState,
    runContext: RunContext<TContext>,
    update: (patch?: Partial<SerializedRunState>) => Promise<void>,
    emit: (type: string, data: unknown) => Promise<void>,
  ): Promise<SerializedRunState | undefined> {
    const pending = state.pendingTool;
    if (!pending) return undefined;
    if (pending.status === 'committed' && pending.result) {
      const alreadyPresent = state.transcript.some(
        item => item.type === 'tool_result' && item.callId === pending.call.id,
      );
      if (!alreadyPresent) {
        const next = cloneState({
          ...state,
          transcript: [...state.transcript, pending.result],
          generatedItems: [...state.generatedItems, pending.result],
          pendingTool: undefined,
        });
        await update(next);
        return next;
      }
      await update({ pendingTool: undefined });
      return cloneState({ ...state, pendingTool: undefined });
    }
    if (pending.status === 'started' && pending.effect === 'side-effect') {
      throw new ToolInterruptionRequiredError({
        type: 'interrupt',
        interruptionId: pending.interruptionId ?? `${state.runId}:${pending.call.id}:reconcile`,
        reason: `Side-effect tool "${pending.call.name}" may have started; manual reconciliation is required.`,
      }, pending.call.name, pending.call.id);
    }
    if (pending.status !== 'awaiting_approval' || !pending.interruptionId) return undefined;
    const decision = decisions.find(item => item.interruptionId === pending.interruptionId);
    if (!decision) {
      throw new ToolInterruptionRequiredError({
        type: 'interrupt',
        interruptionId: pending.interruptionId,
        reason: `Tool "${pending.call.name}" still requires a decision.`,
      }, pending.call.name, pending.call.id);
    }
    if (decision.outcome === 'reject') {
      const result: OutputItem = {
        type: 'tool_result', callId: pending.call.id, name: pending.call.name, status: 'error',
        output: { kind: 'denied', message: decision.reason ?? 'Approval rejected.', retryable: false },
      };
      const next = cloneState({
        ...state,
        pendingTool: undefined,
        transcript: [...state.transcript, result],
        generatedItems: [...state.generatedItems, result],
      });
      await update(next);
      await emit('tool.rejected', { callId: pending.call.id, name: pending.call.name });
      return next;
    }
    await update({ pendingTool: { ...pending, status: 'prepared' } });
    void runContext;
    return cloneState({ ...state, pendingTool: { ...pending, status: 'prepared' } });
  }

  private interruptedResult<TContext, TOutput>(
    agent: AgentSpec<TContext, TOutput>,
    state: SerializedRunState,
  ): RunResult<TOutput> {
    return {
      runId: state.runId,
      agentId: agent.id,
      status: state.status === 'cancelled' ? 'cancelled' : 'interrupted',
      output: '' as TOutput,
      items: state.generatedItems,
      usage: state.usage,
      startedAt: state.startedAt,
      completedAt: new Date().toISOString(),
      sessionId: state.sessionId,
      metadata: state.metadata,
    };
  }

  private claimRun(runId: string, externalSignal?: AbortSignal): AbortController {
    if (this.activeRuns.has(runId)) throw new Error(`Run "${runId}" is already active.`);
    const controller = new AbortController();
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
    this.activeRuns.set(runId, controller);
    return controller;
  }

  private releaseRun(runId: string, controller: AbortController): void {
    if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId);
  }

  private trackSettlement(runId: string, operation: Promise<unknown>): void {
    const settlement = operation.then(() => undefined, () => undefined);
    this.activeSettlements.set(runId, settlement);
    void settlement.then(() => {
      if (this.activeSettlements.get(runId) === settlement) {
        this.activeSettlements.delete(runId);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AgentRuntime is closed.');
  }

  private executeWithSessionLock<TContext, TOutput>(
    seed: ExecutionSeed<TContext, TOutput>,
    signal: AbortSignal,
    observer: ExecutionObserver,
  ): Promise<RunResult<TOutput>> {
    const execute = () => this.runConcurrency.run(
      () => this.execute(seed, signal, observer),
      signal,
    );
    if (!seed.state.sessionId) return execute();
    const key = `${seed.state.tenantId ?? 'default'}\u0000${seed.state.sessionId}`;
    // Serialize a session before taking a global run permit. Otherwise many
    // turns for one busy session could occupy every permit while waiting for
    // the same session lock and starve unrelated sessions.
    return this.sessionTurns.runExclusive(key, execute);
  }

  private pipelineFor(agent: AgentSpec<any, any>): MiddlewarePipeline {
    if (!agent.middleware || agent.middleware.length === 0) return this.middleware;
    const cached = this.agentPipelines.get(agent);
    if (cached) return cached;
    const pipeline = buildMiddlewarePipeline([
      ...this.middleware.definitions(),
      ...this.middlewareRegistry.resolve(agent.middleware),
    ]);
    this.agentPipelines.set(agent, pipeline);
    return pipeline;
  }

  private async resolveSessionStore(runId: string): Promise<RuntimeSessionStore> {
    if (!this.services.has('sessions')) {
      throw new RunError('A sessionId was provided but no sessions service is registered.', {
        code: 'SESSION_SERVICE_REQUIRED', runId, phase: 'runtime',
      });
    }
    return this.services.resolve<RuntimeSessionStore>('sessions');
  }
}

class RuntimeRunHandle<TOutput> implements RunHandle<TOutput> {
  constructor(
    readonly runId: string,
    readonly result: Promise<RunResult<TOutput>>,
    private readonly queue: AsyncQueue<RunEvent>,
    private readonly controller: AbortController,
    private readonly snapshotState: () => SerializedRunState,
  ) {}

  cancel(reason?: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(abortError(reason ?? 'Run cancelled.'));
  }

  snapshot(): Promise<SerializedRunState> {
    return Promise.resolve(this.snapshotState());
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    const iterator = this.queue[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: async () => {
        try {
          await iterator.return?.();
        } finally {
          this.cancel('Run event consumer stopped.');
        }
        return { done: true, value: undefined as never };
      },
      throw: async error => {
        try {
          await iterator.throw?.(error);
        } finally {
          this.cancel('Run event consumer failed.');
        }
        throw error;
      },
    };
  }
}

function createEventQueue(capacity: number): AsyncQueue<RunEvent> {
  return new AsyncQueue<RunEvent>({
    capacity,
    overflowStrategy: 'drop-oldest',
    priorityReserve: 1,
    isPriority: event => event.type.startsWith('run.') && event.type !== 'run.started',
    coalesce: coalesceRunEventDelta,
  });
}

function coalesceRunEventDelta(previous: RunEvent, incoming: RunEvent): RunEvent | undefined {
  if (previous.runId !== incoming.runId || previous.type !== incoming.type) return undefined;
  if (incoming.type !== 'model.text.delta' && incoming.type !== 'model.reasoning.delta') return undefined;
  const previousData = asRecord(previous.data);
  const incomingData = asRecord(incoming.data);
  const left = typeof previousData?.delta === 'string' ? previousData.delta : '';
  const right = typeof incomingData?.delta === 'string' ? incomingData.delta : '';
  if (!left || !right) return undefined;
  return { ...incoming, data: { ...incomingData, delta: left + right } };
}

async function emitModelStreamEvent(
  event: ModelStreamEvent,
  emit: (type: string, data: unknown) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case 'text.delta':
      await emit('model.text.delta', {
        delta: event.delta,
        outputIndex: event.outputIndex,
      });
      return;
    case 'tool_call.delta':
      await emit('model.tool_call.delta', {
        callId: event.callId,
        name: event.name,
        argumentsDelta: event.argumentsDelta,
        outputIndex: event.outputIndex,
      });
      return;
    case 'reasoning.delta':
      await emit('model.reasoning.delta', {
        delta: event.delta,
        opaque: event.opaque,
        outputIndex: event.outputIndex,
      });
      return;
    case 'usage':
      await emit('model.usage', { usage: event.usage });
      return;
    case 'provider.event':
      await emit('model.provider.event', {
        provider: event.provider,
        event: event.event,
      });
      return;
    case 'response.completed':
      await emit('model.response.completed', {
        responseId: event.response.id,
        finishReason: event.response.finishReason,
      });
      return;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeInput(input: AgentInput): readonly InputItem[] {
  if (typeof input === 'string') return [{ type: 'text', role: 'user', text: input }];
  return cloneItems(Array.isArray(input) ? input : [input as InputItem]);
}

function cloneItems<T extends InputItem | OutputItem>(items: readonly T[]): T[] {
  return structuredClone(items) as T[];
}

function cloneState(state: SerializedRunState): SerializedRunState {
  return structuredClone(state);
}

function resolveLimits(base: RunLimits, patch?: Partial<RunLimits>): RunLimits {
  const limits = { ...base, ...patch };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Run limit ${name} must be a positive finite number.`);
    }
  }
  for (const name of ['maxTurns', 'maxParallelTools', 'maxSubagentDepth', 'maxSubagentFanout', 'streamBufferSize'] as const) {
    if (!Number.isSafeInteger(limits[name])) throw new RangeError(`Run limit ${name} must be a safe integer.`);
  }
  if (limits.streamBufferSize < 2) throw new RangeError('streamBufferSize must be at least 2.');
  return Object.freeze(limits);
}

function assertAgentSpec(agent: AgentSpec<any, any>): void {
  if (!agent.id.trim()) throw new TypeError('Agent id must not be empty.');
  if (!agent.name.trim()) throw new TypeError('Agent name must not be empty.');
  if (typeof agent.instructions !== 'string' && typeof agent.instructions !== 'function') {
    throw new TypeError(`Agent "${agent.id}" instructions must be a string or function.`);
  }
}

async function resolveInstructions<TContext>(
  agent: AgentSpec<TContext, unknown>,
  context: RunContext<TContext>,
): Promise<string> {
  const instructions = typeof agent.instructions === 'function'
    ? await agent.instructions(context)
    : agent.instructions;
  if (typeof instructions !== 'string') throw new TypeError('Agent instructions must resolve to a string.');
  return instructions;
}

async function runInputGuardrails<TContext>(
  agent: AgentSpec<TContext, unknown>,
  context: RunContext<TContext>,
  input: readonly InputItem[],
): Promise<void> {
  for (const guardrail of agent.inputGuardrails ?? []) {
    const decision = await guardrail.evaluate(context, input);
    if (!decision.allowed) throw new RunError(decision.reason ?? `Input guardrail ${guardrail.id} rejected input.`, {
      code: 'INPUT_GUARDRAIL_REJECTED', runId: context.runId, phase: 'prepare_input',
    });
  }
}

async function runOutputGuardrails<TContext, TOutput>(
  agent: AgentSpec<TContext, TOutput>,
  context: RunContext<TContext>,
  output: TOutput,
): Promise<void> {
  for (const guardrail of agent.outputGuardrails ?? []) {
    const decision = await guardrail.evaluate(context, output);
    if (!decision.allowed) throw new RunError(decision.reason ?? `Output guardrail ${guardrail.id} rejected output.`, {
      code: 'OUTPUT_GUARDRAIL_REJECTED', runId: context.runId, phase: 'finalize_output',
    });
  }
}

function finalizeOutput<TContext, TOutput>(
  agent: AgentSpec<TContext, TOutput>,
  response: ModelResponse,
): TOutput {
  if (agent.output) {
    if (response.structuredOutput === undefined) throw new RunError(
      `Model did not return structured output for schema "${agent.output.name}".`,
      { code: 'STRUCTURED_OUTPUT_MISSING', phase: 'finalize_output' },
    );
    return agent.output.parse
      ? agent.output.parse(response.structuredOutput)
      : response.structuredOutput as TOutput;
  }
  return response.output
    .filter(item => item.type === 'text' && item.role === 'assistant')
    .map(item => item.type === 'text' ? item.text : '')
    .join('') as TOutput;
}

function enforceUsageLimits(usage: UsageAccumulator, limits: RunLimits, runId: string): void {
  const value = usage.snapshot();
  if (value.totalTokens > limits.maxTotalTokens || value.costUsd > limits.maxCostUsd) {
    throw new RunError('Run usage budget exceeded.', {
      code: 'USAGE_LIMIT_EXCEEDED', runId, phase: 'model_call',
      details: { totalTokens: value.totalTokens, costUsd: value.costUsd },
    });
  }
}

const MODEL_FINISH_REASONS = new Set<ModelResponse['finishReason']>([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'refusal',
  'cancelled',
  'error',
  'unknown',
]);

const OUTPUT_ITEM_TYPES = new Set<OutputItem['type']>([
  'text',
  'image',
  'audio',
  'document',
  'artifact_ref',
  'tool_call',
  'tool_result',
  'handoff_call',
  'handoff_result',
  'reasoning',
  'raw',
  'structured',
  'refusal',
  'error',
]);

function validateModelResponse(response: ModelResponse, runId: string): ModelResponse {
  try {
    if (!response || typeof response !== 'object') throw new TypeError('response must be an object');
    if (typeof response.id !== 'string' || response.id.trim().length === 0) {
      throw new TypeError('response.id must be a non-empty string');
    }
    if (
      !response.model
      || typeof response.model.providerId !== 'string'
      || response.model.providerId.trim().length === 0
      || typeof response.model.modelId !== 'string'
      || response.model.modelId.trim().length === 0
    ) {
      throw new TypeError('response.model must identify a provider and model');
    }
    if (!MODEL_FINISH_REASONS.has(response.finishReason)) {
      throw new TypeError(`response.finishReason is invalid: ${String(response.finishReason)}`);
    }
    if (!Array.isArray(response.output)) throw new TypeError('response.output must be an array');
    assertJsonValue(response.output, 'Model response output');
    for (const item of response.output) {
      if (!item || typeof item !== 'object' || !OUTPUT_ITEM_TYPES.has(item.type)) {
        throw new TypeError(`response.output contains an unknown item type: ${String(item?.type)}`);
      }
    }
    if (response.structuredOutput !== undefined) {
      assertJsonValue(response.structuredOutput, 'Model structured output');
    }
    if (response.rawResponse !== undefined) {
      assertJsonValue(response.rawResponse, 'Raw model response');
    }
    const validatedUsage = new UsageAccumulator(response.usage).snapshot();
    return { ...response, usage: validatedUsage };
  } catch (cause) {
    throw new MiddlewareInvariantViolationError(
      MiddlewareStage.WrapModelCall,
      runId,
      'Model middleware returned a response that violates the canonical response contract.',
      cause,
    );
  }
}

function validateToolTerminalOutput(
  definition: ReturnType<ToolRegistry['resolve']>,
  output: unknown,
  call: ToolCallItem,
  runId: string,
): ToolOutput<unknown> {
  try {
    if (!definition) throw new TypeError(`Unknown tool "${call.name}".`);
    if (!output || typeof output !== 'object' || !Object.hasOwn(output, 'value')) {
      throw new TypeError('tool middleware must return a ToolOutput object');
    }
    const candidate = output as ToolOutput<unknown>;
    assertJsonValue(candidate.value, `Output from tool "${call.name}"`);
    if (candidate.modelText !== undefined && typeof candidate.modelText !== 'string') {
      throw new TypeError('ToolOutput.modelText must be a string');
    }
    if (candidate.artifacts !== undefined) {
      if (!Array.isArray(candidate.artifacts)) throw new TypeError('ToolOutput.artifacts must be an array');
      for (const artifact of candidate.artifacts) {
        if (!artifact || typeof artifact.id !== 'string' || artifact.id.trim().length === 0) {
          throw new TypeError('Every tool artifact must have a non-empty id');
        }
      }
    }
    return candidate;
  } catch (cause) {
    throw new MiddlewareInvariantViolationError(
      MiddlewareStage.WrapToolCall,
      runId,
      `Tool middleware returned invalid output for "${call.name}".`,
      cause,
    );
  }
}

function freezeToolOutput(output: ToolOutput<unknown>): ToolOutput<unknown> {
  deepFreezeJson(output.value as JsonValue);
  if (output.artifacts) {
    for (const artifact of output.artifacts) Object.freeze(artifact);
    Object.freeze(output.artifacts);
  }
  return Object.freeze(output);
}

function deepFreezeJson(value: JsonValue): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepFreezeJson(child);
  }
  Object.freeze(value);
}

function toJsonValue(value: unknown, toolName: string): JsonValue {
  assertJsonValue(value, `Output from tool "${toolName}"`);
  return value;
}

function toolFailureResult(
  call: ToolCallItem,
  error: ToolExecutionError,
  formatted: string,
): OutputItem {
  return {
    type: 'tool_result',
    callId: call.id,
    name: call.name,
    status: 'error',
    output: {
      kind: error.failure.kind,
      message: formatted,
      retryable: error.failure.retryable,
    },
  };
}

interface RunConcurrencyWaiter {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

/** Fair, abort-aware gate for top-level runtime work. */
class RunConcurrencyGate {
  private readonly waiters: RunConcurrencyWaiter[] = [];
  private active = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('maxConcurrentRuns must be a positive safe integer.');
    }
  }

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      await this.acquire(signal);
    } catch (error) {
      // Runtime cancellation is a normal terminal result, not a rejected
      // top-level run. Let the state machine emit/return that result without
      // consuming a permit when cancellation happens in the wait queue.
      if (signal.aborted) return operation();
      throw error;
    }
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? abortError('Run cancelled before execution.'));
    }
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let waiter!: RunConcurrencyWaiter;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? abortError('Run cancelled while waiting for execution.'));
      };
      waiter = { signal, resolve, reject, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(
          waiter.signal.reason ?? abortError('Run cancelled while waiting for execution.'),
        );
        continue;
      }
      this.active += 1;
      waiter.resolve();
      return;
    }
  }
}

interface Boundary {
  readonly signal: AbortSignal;
  dispose(): void;
}

function createBoundary(parent: AbortSignal, timeoutMs: number, message: string): Boundary {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  if (parent.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted && timeoutMs <= 0) {
    controller.abort(abortError(message));
  } else if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(abortError(message)), timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError('Operation aborted.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError('Operation aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeError(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function validateSerializedState(state: SerializedRunState): void {
  if (state.schemaVersion !== 1) throw new TypeError(`Unsupported run state version ${state.schemaVersion}.`);
  if (!state.runId || !state.agentId) throw new TypeError('Serialized run state is missing identity.');
}

function agentDigest(agent: AgentSpec<any, any>): string {
  const value = JSON.stringify({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    instructions: typeof agent.instructions === 'string' ? agent.instructions : '[function]',
    model: agent.model,
    tools: agent.tools,
    handoffs: agent.handoffs?.map(handoff => ({ id: handoff.id, targetAgentId: handoff.targetAgentId })),
    output: agent.output ? { name: agent.output.name, schema: agent.output.schema, strict: agent.output.strict } : undefined,
    limits: agent.limits,
    metadata: agent.metadata,
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function childTrace(runId: string, parentRunId: string, parent: TraceContext): RunEventContext {
  const trace = createRootTraceContext(runId);
  return {
    runId,
    parentRunId,
    traceId: parent.traceId,
    spanId: trace.spanId,
    parentSpanId: parent.spanId,
  };
}
