import { describe, expect, it, vi } from 'vitest';

import {
  createRootTraceContext,
  type EventProcessor,
  type EventSink,
} from '../src/events/index.js';
import {
  emptyUsage,
  type AgentSpec,
  type InputItem,
  type JsonValue,
  type RunResult,
} from '../src/core/index.js';
import {
  mergeModelCapabilities,
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  type ModelCallContext,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStream,
  type ModelStreamEvent,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import {
  AgentRuntime,
  buildMiddlewarePipeline,
  createMiddlewarePipelineBuilder,
  defineMiddleware,
  isMiddlewareStage,
  MiddlewareConfigurationError,
  MiddlewareDeadlineExceededError,
  MiddlewareRegistry,
  middlewareStageIndex,
  MiddlewareStage,
  RuntimeServices,
  type RuntimeService,
  ToolExecutionError,
  ToolInterruptionRequiredError,
  ToolRegistry,
  ToolRunner,
  toolEffect,
  type RuntimeTool,
  type SerializedRunState,
} from '../src/runtime-v2/index.js';

const MODEL: ResolvedModel = {
  providerId: 'scenario', modelId: 'model',
  ref: { provider: 'scenario', model: 'model' },
};
const CAPABILITIES = mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, {
  input: { image: true, audio: true, document: true, artifact: true },
  output: { image: true, audio: true, structured: true },
  tools: { function: true, parallel: true, hosted: true },
  reasoning: { request: true, opaqueRoundTrip: true },
  streaming: true, promptCaching: true, stopSequences: true, providerRawRoundTrip: true,
});

describe('RuntimeServices and middleware defensive contracts', () => {
  it('validates registration, cached lookup, close races, and aggregate close failures', async () => {
    const services = new RuntimeServices();
    expect(() => services.register(' ', { factory: () => ({}) })).toThrow(/id/);
    services.register('plain', { factory: () => ({}) });
    expect(() => services.register('plain', { factory: () => ({}) })).toThrow(/already/);
    expect(services.has('plain')).toBe(true);
    expect(services.has('missing')).toBe(false);
    await expect(services.resolve('missing')).rejects.toThrow(/not registered/);
    const first = await services.resolve('plain');
    expect(await services.resolve('plain')).toBe(first);

    const failure = new RuntimeServices({
      noClose: { factory: () => ({}) },
      broken: { factory: () => ({ close: () => { throw new Error('close failed'); } }) },
    });
    await failure.resolve('noClose');
    await failure.resolve('broken');
    await expect(failure.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(failure.close()).resolves.toBeUndefined();

    let finish!: (value: RuntimeService) => void;
    const pending = new RuntimeServices({
      slow: { factory: () => new Promise<RuntimeService>(resolve => { finish = resolve; }) },
    });
    const resolving = pending.resolve('slow');
    await vi.waitFor(() => expect(pending.inspect()[0]?.pending).toBe(true));
    await pending.close();
    const close = vi.fn<() => void>();
    finish({ close });
    await expect(resolving).rejects.toThrow(/closed during initialization/);
    expect(close).toHaveBeenCalledOnce();

    await services.close();
    expect(() => services.register('late', { factory: () => ({}) })).toThrow(/closed/);
    await expect(services.resolve('plain')).rejects.toThrow(/closed/);
  });

  it('validates middleware definitions, contexts, registries, and stage diagnostics', async () => {
    for (const definition of [
      null,
      { name: ' ', stage: MiddlewareStage.BeforeRun, priority: 0, handle: () => undefined },
      { name: 'bad-stage', stage: 'bad', priority: 0, handle: () => undefined },
      { name: 'bad-priority', stage: MiddlewareStage.BeforeRun, priority: 0.5, handle: () => undefined },
      { name: 'bad-handler', stage: MiddlewareStage.BeforeRun, priority: 0, handle: null },
    ]) expect(() => buildMiddlewarePipeline([definition as any])).toThrow(MiddlewareConfigurationError);

    const definition = defineMiddleware({
      name: 'valid', stage: MiddlewareStage.BeforeRun, priority: 1,
      handle: async (_context, next) => next(),
    });
    const pipeline = createMiddlewarePipelineBuilder().useAll([definition]).build();
    expect(pipeline.definitions()).toHaveLength(1);
    expect(pipeline.format()).toContain('valid');
    expect(() => pipeline.inspect('bad' as MiddlewareStage)).toThrow(/Unknown middleware stage/);
    expect(() => pipeline.run('bad' as MiddlewareStage, {
      signal: new AbortController().signal,
    }, () => 'x')).toThrow(/Unknown middleware stage/);
    for (const context of [
      null,
      {},
      { signal: {} },
      { signal: new AbortController().signal, deadline: { expiresAt: -1 } },
      { signal: new AbortController().signal, deadline: { expiresAt: Number.NaN } },
    ]) expect(() => pipeline.run(MiddlewareStage.BeforeRun, context as any, () => 'x'))
      .toThrow(/Middleware context/);
    await expect(pipeline.run(MiddlewareStage.BeforeRun, {
      signal: new AbortController().signal,
      deadline: { expiresAt: Date.now() - 1 },
    }, () => 'x')).rejects.toBeInstanceOf(MiddlewareDeadlineExceededError);

    expect(isMiddlewareStage(MiddlewareStage.BeforeRun)).toBe(true);
    expect(isMiddlewareStage(1)).toBe(false);
    expect(() => middlewareStageIndex('bad' as MiddlewareStage)).toThrow(/Unknown/);

    const registry = new MiddlewareRegistry();
    expect(() => registry.register(' ', definition)).toThrow(/id/);
    expect(() => registry.register('empty', [])).toThrow(/contain/);
    registry.register('one', definition);
    expect(registry.has('one')).toBe(true);
    expect(() => registry.register('one', definition)).toThrow(/already/);
    registry.register('one', [definition], { replace: true });
    expect(registry.resolve([{ id: 'one' }])).toEqual([definition]);
    expect(registry.resolve()).toEqual([]);
    expect(registry.list()).toEqual(['one']);
  });
});

describe('Tool runtime failure and cancellation matrix', () => {
  it('validates registry descriptors and list/resolve behavior', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(runtimeTool({ name: ' ' }))).toThrow(/name/);
    expect(() => registry.register({
      descriptor: runtimeTool().descriptor, execute: null,
    } as any)).toThrow(/execute/);
    registry.register(runtimeTool({ name: 'z' }));
    registry.register(runtimeTool({ name: 'a', effect: 'read' }));
    expect(registry.has('a')).toBe(true);
    expect(registry.resolve('missing')).toBeUndefined();
    expect(registry.list().map(item => item.name)).toEqual(['a', 'z']);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(toolEffect(registry.resolve('a')!.descriptor)).toBe('read');
  });

  it('covers not-found, policy allow/interrupt, approval, output, execution, and formatter paths', async () => {
    const context = toolContext();
    const registry = new ToolRegistry([runtimeTool()]);
    const runner = new ToolRunner({ registry });
    await expect(runner.execute('missing', 1, context)).rejects.toMatchObject({
      failure: { kind: 'not_found' },
    });
    await expect(runner.execute('tool', 2, context)).resolves.toEqual({ value: 4 });

    const envelope = runtimeTool({
      execute: () => ({ value: 3, artifacts: [{ id: 'artifact' }], modelText: 'three' }),
    });
    await expect(new ToolRunner({ registry: new ToolRegistry([envelope]) })
      .execute('tool', 1, context)).resolves.toMatchObject({
        value: 3, artifacts: [{ id: 'artifact' }], modelText: 'three',
      });

    const invalidOutput = runtimeTool({ outputParse: () => { throw new Error('bad output'); } });
    await expect(new ToolRunner({ registry: new ToolRegistry([invalidOutput]) })
      .execute('tool', 1, context)).rejects.toMatchObject({ failure: { kind: 'validation' } });

    const interrupted = new ToolRunner({
      registry,
      policy: { authorize: () => ({
        type: 'interrupt', interruptionId: 'approval', reason: 'ask user', metadata: { one: true },
      }) },
    });
    await expect(interrupted.execute('tool', 1, context)).rejects.toBeInstanceOf(
      ToolInterruptionRequiredError,
    );
    const allowed = new ToolRunner({
      registry,
      policy: { authorize: () => ({ type: 'allow' }) },
      errorFormatter: { format: failure => `formatted:${failure.kind}` },
    });
    await expect(allowed.execute('tool', 1, context)).resolves.toEqual({ value: 2 });

    const execution = runtimeTool({ execute: () => { throw 'plain failure'; } });
    const executionRunner = new ToolRunner({ registry: new ToolRegistry([execution]) });
    let caught: unknown;
    try {
      await executionRunner.execute('tool', 1, context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const error = caught as ToolExecutionError;
    expect(error.failure.kind).toBe('execution');
    expect(executionRunner.formatFailure(error)).toContain('execution:');
    expect(allowed.formatFailure(error)).toBe('formatted:execution');

    const approvedDefinition = runtimeTool({ requiresApproval: true });
    const approvedRunner = new ToolRunner({ registry: new ToolRegistry([approvedDefinition]) });
    await expect(approvedRunner.execute('tool', 1, {
      ...context, approval: { interruptionId: 'i', outcome: 'approve' },
    })).resolves.toEqual({ value: 2 });
  });

  it('enforces invalid/expired deadlines and parent cancellation', async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const runner = new ToolRunner({ registry: new ToolRegistry([runtimeTool({ timeoutMs })]) });
      await expect(runner.execute('tool', 1, toolContext())).rejects.toThrow(/timeoutMs/);
    }
    const expired = new ToolRunner({
      registry: new ToolRegistry([runtimeTool({ execute: () => new Promise(() => undefined) })]),
    });
    await expect(expired.execute('tool', 1, {
      ...toolContext(), deadline: Date.now() - 1,
    })).rejects.toMatchObject({ failure: { kind: 'timeout' } });

    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    const controller = new AbortController();
    const cancelled = new ToolRunner({ registry: new ToolRegistry([runtimeTool({
      execute: () => { started(); return new Promise(() => undefined); },
    })]) }).execute('tool', 1, toolContext(controller.signal));
    await gate;
    controller.abort(new Error('cancel tool'));
    await expect(cancelled).rejects.toMatchObject({ failure: { kind: 'cancelled' } });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(new ToolRunner({ registry: new ToolRegistry([runtimeTool()]) })
      .execute('tool', 1, toolContext(preAborted.signal)))
      .rejects.toMatchObject({ failure: { kind: 'cancelled' } });
  });
});

describe('AgentRuntime failure, resume, stream, and lifecycle matrix', () => {
  it('validates agent identities, instructions, limits, models, tools, and duplicate runs', async () => {
    const provider = new ScenarioProvider(() => textResponse('ok'));
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]) });
    for (const agent of [
      { id: ' ', name: 'name', instructions: 'x', model: 'scenario:model' },
      { id: 'id', name: ' ', instructions: 'x', model: 'scenario:model' },
      { id: 'id', name: 'name', instructions: 1, model: 'scenario:model' },
    ]) await expect(runtime.run(agent as any, 'x')).rejects.toThrow(/Agent|instructions/);
    for (const limits of [
      { maxTurns: 0 }, { maxTurns: 1.5 }, { streamBufferSize: 1 }, { maxCostUsd: Number.NaN },
    ]) await expect(runtime.run({ ...baseAgent(), id: `limits-${Math.random()}`, limits }, 'x'))
      .rejects.toThrow(/Run limit|streamBufferSize/);
    await expect(runtime.run({ ...baseAgent(), id: 'dynamic', instructions: async () => 1 as any }, 'x'))
      .rejects.toThrow(/resolve to a string/);
    await expect(runtime.run({ ...baseAgent(), id: 'no-model', model: undefined }, 'x'))
      .rejects.toMatchObject({ code: 'MODEL_REQUIRED' });
    await expect(runtime.run({ ...baseAgent(), id: 'unknown-tool', tools: ['missing'] }, 'x'))
      .rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });

    const same = baseAgent('same');
    runtime.registerAgent(same);
    expect(runtime.registerAgent(same)).toBe(runtime);
    expect(() => runtime.registerAgent({ ...same })).toThrow(/already registered/);

    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const hanging = new ScenarioProvider(() => { begin(); return new Promise(() => undefined); });
    const activeRuntime = new AgentRuntime({ models: new ModelRegistry([hanging]) });
    const activeAgent = baseAgent();
    const first = activeRuntime.run(activeAgent, 'x', { runId: 'same-run' });
    await started;
    await expect(activeRuntime.run(activeAgent, 'x', { runId: 'same-run' }))
      .rejects.toThrow(/already active/);
    await activeRuntime.close();
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    await expect(activeRuntime.run(baseAgent(), 'x')).rejects.toThrow(/closed/);
    await activeRuntime.close();
    await runtime.close();
  });

  it('executes dynamic instructions and input/output guardrail allow/deny branches', async () => {
    const provider = new ScenarioProvider(() => textResponse('answer'));
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]) });
    const allowed = vi.fn(() => ({ allowed: true }));
    await expect(runtime.run({
      ...baseAgent('allowed'), instructions: context => `run:${context.runId}`,
      inputGuardrails: [{ id: 'input', evaluate: allowed }],
      outputGuardrails: [{ id: 'output', evaluate: allowed }],
    }, { type: 'text', role: 'user', text: 'item' })).resolves.toMatchObject({ output: 'answer' });
    expect(provider.requests[0]?.input[0]).toMatchObject({ type: 'text', role: 'system' });

    await expect(runtime.run({
      ...baseAgent('input-denied'), inputGuardrails: [{
        id: 'input', evaluate: () => ({ allowed: false }),
      }],
    }, [{ type: 'text', role: 'user', text: 'array' }])).rejects.toMatchObject({
      code: 'INPUT_GUARDRAIL_REJECTED', phase: 'prepare_input',
    });
    await expect(runtime.run({
      ...baseAgent('output-denied'), outputGuardrails: [{
        id: 'output', evaluate: () => ({ allowed: false, reason: 'unsafe output' }),
      }],
    }, 'x')).rejects.toMatchObject({ code: 'OUTPUT_GUARDRAIL_REJECTED' });
    await runtime.close();
  });

  it('validates structured output and aggregate usage budgets', async () => {
    const missing = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => textResponse('not structured'))]),
    });
    await expect(missing.run({
      ...baseAgent(), output: { name: 'schema', schema: { type: 'object' } },
    }, 'x')).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_MISSING' });
    await missing.close();

    const structured = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => ({
        ...textResponse('ignored'), structuredOutput: { answer: 1 },
      }))]),
    });
    await expect(structured.run({
      ...baseAgent(), output: { name: 'schema', schema: {}, parse: undefined },
    }, 'x')).resolves.toMatchObject({ output: { answer: 1 } });
    await structured.close();

    for (const usage of [
      { ...emptyUsage(), requests: 0, totalTokens: 3 },
      { ...emptyUsage(), requests: 1, costUsd: 2 },
    ]) {
      const runtime = new AgentRuntime({
        models: new ModelRegistry([new ScenarioProvider(() => ({ ...textResponse('x'), usage }))]),
      });
      await expect(runtime.run({
        ...baseAgent(), limits: { maxTotalTokens: 2, maxCostUsd: 1 },
      }, 'x')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
      await runtime.close();
    }
  });

  it('turns unknown/failed tools into canonical results and enforces max turns', async () => {
    let call = 0;
    const provider = new ScenarioProvider(() => {
      call += 1;
      return call <= 2 ? toolResponse('bad', `call-${call}`) : textResponse('done');
    });
    const bad = runtimeTool({ name: 'bad', execute: () => { throw new Error('tool exploded'); } });
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]), tools: new ToolRegistry([bad]),
    });
    await expect(runtime.run({ ...baseAgent(), tools: ['bad'] }, 'x')).resolves.toMatchObject({ output: 'done' });
    expect(provider.requests[1]?.input).toContainEqual(expect.objectContaining({
      type: 'tool_result', status: 'error', output: expect.objectContaining({ kind: 'execution' }),
    }));
    await runtime.close();

    const looping = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => toolResponse('read', 'call'))]),
      tools: new ToolRegistry([runtimeTool({ name: 'read', effect: 'read' })]),
    });
    await expect(looping.run({
      ...baseAgent(), tools: ['read'], limits: { maxTurns: 1 },
    }, 'x')).rejects.toMatchObject({ code: 'MAX_TURNS_EXCEEDED' });
    await looping.close();
  });

  it('resumes approval rejection, missing decisions, reconciliation, and committed results', async () => {
    const execute = vi.fn(() => ({ ok: true }));
    const provider = new ScenarioProvider((_request, index) => index === 0
      ? toolResponse('write', 'write-call')
      : textResponse('after decision'));
    const write = runtimeTool({ name: 'write', requiresApproval: true, execute });
    const agent = { ...baseAgent(), tools: ['write'] };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]), tools: new ToolRegistry([write]),
      agents: [agent],
    });
    const initial = runtime.stream(agent, 'x');
    await expect(initial.result).resolves.toMatchObject({ status: 'interrupted' });
    const state = await initial.snapshot();

    const waiting = runtime.resume(state);
    await expect(waiting.result).resolves.toMatchObject({ status: 'interrupted' });

    const rejected = runtime.resume(state, [{
      interruptionId: state.pendingTool!.interruptionId!, outcome: 'reject', reason: 'no',
    }]);
    await expect(rejected.result).resolves.toMatchObject({ status: 'completed', output: 'after decision' });
    expect(execute).not.toHaveBeenCalled();

    const startedState: SerializedRunState = structuredClone({
      ...state, pendingTool: { ...state.pendingTool!, status: 'started' },
    });
    const reconcile = runtime.resume(startedState);
    await expect(reconcile.result).resolves.toMatchObject({ status: 'interrupted' });

    const resultItem = {
      type: 'tool_result' as const, callId: 'write-call', name: 'write',
      status: 'success' as const, output: { ok: true },
    };
    const committed = runtime.resume(structuredClone({
      ...state,
      pendingTool: { ...state.pendingTool!, status: 'committed', result: resultItem },
    }));
    await expect(committed.result).resolves.toMatchObject({ status: 'completed' });
    await runtime.close();
  });

  it('validates resume identity/config/deadline/session services and revision conflicts', async () => {
    const agent = baseAgent();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => textResponse('ok'))]), agents: [agent],
    });
    for (const state of [
      { schemaVersion: 2 },
      { schemaVersion: 1, runId: '', agentId: '' },
    ]) expect(() => runtime.resume(state as any)).toThrow(/version|identity/);
    expect(() => runtime.resume(validState({ agentId: 'missing' }))).toThrow(/not registered/);

    const first = runtime.stream(agent, 'x');
    await first.result;
    const completed = await first.snapshot();
    expect(() => runtime.resume({ ...completed, agentConfigDigest: 'changed' }))
      .toThrow(/configuration changed/);
    const badDeadline = { ...completed, status: 'interrupted' as const, deadlineAt: 'not-a-date' };
    const bad = runtime.resume(badDeadline);
    await expect(bad.result).rejects.toMatchObject({ code: 'RUN_DEADLINE_INVALID' });
    await expect(runtime.run(agent, 'x', { sessionId: 'session' }))
      .rejects.toMatchObject({ code: 'SESSION_SERVICE_REQUIRED' });
    await runtime.close();

    const sessions = {
      load: vi.fn(async () => ({ items: [], revision: '2' })),
      append: vi.fn(async () => ({ revision: '3' })),
      close: () => undefined,
    };
    const sessionRuntime = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => textResponse('ok'))]),
      services: new RuntimeServices({ sessions: { factory: () => sessions } }),
      agents: [agent],
    });
    const interruptedState = validState({
      agentId: agent.id, agentConfigDigest: digestAgent(agent),
      sessionId: 'session', tenantId: 'tenant', turn: 1, expectedSessionRevision: '1',
    });
    const conflict = sessionRuntime.resume(interruptedState);
    await expect(conflict.result).rejects.toMatchObject({ code: 'SESSION_REVISION_CONFLICT' });
    await sessionRuntime.close();
  });

  it('maps every model stream event, child trace, iterator return/throw, and filtered event', async () => {
    const response = textResponse('final');
    const events: ModelStreamEvent[] = [
      { type: 'text.delta', delta: 'a', outputIndex: 0 },
      { type: 'tool_call.delta', callId: 'call', name: 'tool', argumentsDelta: '{}', outputIndex: 1 },
      { type: 'reasoning.delta', delta: 'why', opaque: { safe: true }, outputIndex: 2 },
      { type: 'usage', usage: response.usage },
      { type: 'provider.event', provider: 'scenario', event: { type: 'opaque' } },
      { type: 'response.completed', response },
    ];
    const provider = new ScenarioProvider(() => response, events);
    const seen: string[] = [];
    const sink: EventSink = { id: 'sink', write: event => { seen.push(event.type); } };
    const processor: EventProcessor = {
      id: 'filter-requested',
      process: event => event.type === 'model.requested' ? null : event,
    };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]), eventSinks: [sink], eventProcessors: [processor],
    });
    const parentTrace = createRootTraceContext('parent');
    const handle = runtime.stream(baseAgent(), 'x', {
      parentRunId: 'parent', parentTrace,
    });
    const streamed = [];
    for await (const event of handle) streamed.push(event.type);
    expect(streamed).toEqual(expect.arrayContaining([
      'model.text.delta', 'model.tool_call.delta', 'model.reasoning.delta',
      'model.usage', 'model.provider.event', 'model.response.completed',
    ]));
    expect(streamed).not.toContain('model.requested');
    expect(seen).toContain('run.completed');

    const cancelRuntime = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => new Promise(() => undefined), [])]),
    });
    const returned = cancelRuntime.stream(baseAgent('return'), 'x');
    const iterator = returned[Symbol.asyncIterator]();
    await within(iterator.next(), 'return iterator first event');
    await within(iterator.return?.() ?? Promise.resolve({ done: true, value: undefined as never }), 'return iterator close');
    await expect(within(returned.result, 'return run result')).resolves.toMatchObject({ status: 'cancelled' });

    const thrown = cancelRuntime.stream(baseAgent('throw'), 'x');
    const throwingIterator = thrown[Symbol.asyncIterator]();
    await within(throwingIterator.next(), 'throw iterator first event');
    await expect(within(
      throwingIterator.throw?.(new Error('consumer failed'))
        ?? Promise.reject(new Error('throw method missing')),
      'throw iterator close',
    )).rejects.toThrow('consumer failed');
    await expect(within(thrown.result, 'throw run result')).resolves.toMatchObject({ status: 'cancelled' });
    await within(cancelRuntime.close(), 'cancel runtime close');
    await runtime.close();
  });

  it('aggregates event/service close failures and checkpoint save/delete calls', async () => {
    const saves: SerializedRunState[] = [];
    const checkpointStore = {
      save: async (state: SerializedRunState) => { saves.push(structuredClone(state)); },
      load: async () => undefined,
      delete: vi.fn(async () => undefined),
    };
    const services = new RuntimeServices({
      broken: { factory: () => ({ close: () => { throw new Error('service close'); } }) },
    });
    await services.resolve('broken');
    const sink: EventSink = {
      id: 'broken', write: () => undefined, close: () => { throw new Error('sink close'); },
    };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([new ScenarioProvider(() => textResponse('ok'))]),
      checkpointStore, services, eventSinks: [sink],
    });
    await runtime.run(baseAgent(), 'x');
    expect(saves.length).toBeGreaterThan(1);
    expect(checkpointStore.delete).toHaveBeenCalledOnce();
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
  });

  it('covers default model, empty instructions, external abort, pipeline cache, delta coalescing, and committed replay', async () => {
    const response = textResponse('done');
    const provider = new ScenarioProvider(() => response, [
      { type: 'text.delta', delta: 'a' },
      { type: 'text.delta', delta: 'b' },
      { type: 'reasoning.delta', delta: 'c' },
      { type: 'reasoning.delta', delta: 'd' },
      { type: 'response.completed', response },
    ]);
    const middleware = buildMiddlewarePipeline([]);
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]), defaultModel: 'scenario:model', middleware,
    });
    const agent = { ...baseAgent('defaults'), model: undefined, instructions: '', middleware: [] };
    const handle = runtime.stream(agent, 'x');
    await handle.result;
    const deltas: string[] = [];
    for await (const event of handle) {
      if (event.type === 'model.text.delta' || event.type === 'model.reasoning.delta') {
        deltas.push(String((event.data as { delta?: unknown }).delta));
      }
    }
    expect(deltas.join('')).toContain('ab');
    expect(provider.requests[0]?.input[0]).toMatchObject({ role: 'user' });
    expect(runtime.inspectMiddleware(agent)).toBe('');
    expect(runtime.inspectMiddleware(agent)).toBe('');

    const abort = new AbortController();
    abort.abort(new Error('pre-aborted run'));
    await expect(runtime.run({ ...agent, id: 'aborted' }, 'x', { signal: abort.signal }))
      .resolves.toMatchObject({ status: 'cancelled' });

    const approvalProvider = new ScenarioProvider((_request, index) => index === 0
      ? toolResponse('write', 'call')
      : textResponse('resumed'));
    const approvalAgent = { ...baseAgent('approval-cache'), tools: ['write'] };
    const approvalRuntime = new AgentRuntime({
      models: new ModelRegistry([approvalProvider]),
      tools: new ToolRegistry([runtimeTool({ name: 'write', requiresApproval: true })]),
      agents: [approvalAgent],
    });
    const interrupted = approvalRuntime.stream(approvalAgent, 'x');
    await interrupted.result;
    const state = await interrupted.snapshot();
    const resultItem = {
      type: 'tool_result' as const, callId: 'call', name: 'write',
      status: 'success' as const, output: { ok: true },
    };
    const replay = approvalRuntime.resume({
      ...state,
      transcript: [...state.transcript, resultItem],
      generatedItems: [...state.generatedItems, resultItem],
      pendingTool: { ...state.pendingTool!, status: 'committed', result: resultItem },
    });
    await expect(replay.result).resolves.toMatchObject({ status: 'completed', output: 'resumed' });
    await approvalRuntime.close();
    await runtime.close();
  });
});

class ScenarioProvider implements ModelProvider {
  readonly id = 'scenario';
  readonly requests: ModelRequest[] = [];
  private streamCount = 0;

  constructor(
    private readonly respond: (request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>,
    private readonly streamEvents?: readonly ModelStreamEvent[],
  ) {}

  async resolve(): Promise<ResolvedModel> { return MODEL; }
  async capabilities() { return CAPABILITIES; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.push(request) - 1;
    return this.respond(request, index);
  }
  stream(request: ModelRequest, _context: ModelCallContext): ModelStream {
    const index = this.requests.push(request) - 1;
    const response = Promise.resolve(this.respond(request, index));
    const events = this.streamEvents;
    let cancelled = false;
    this.streamCount += 1;
    return {
      cancel: () => { cancelled = true; },
      finalResponse: () => response,
      async *[Symbol.asyncIterator]() {
        if (events) {
          for (const event of events) {
            if (cancelled) return;
            yield event;
          }
          return;
        }
        const final = await response;
        if (!cancelled) yield { type: 'response.completed' as const, response: final };
      },
    };
  }
}

function baseAgent(id = 'agent'): AgentSpec<any, any> {
  return { id, name: id, instructions: 'Be useful.', model: 'scenario:model' };
}

function textResponse(text: string): ModelResponse {
  return {
    id: `response-${text}`, model: MODEL, finishReason: 'stop',
    output: [{ type: 'text', role: 'assistant', text }], usage: emptyUsage(),
  };
}

function toolResponse(name: string, id: string): ModelResponse {
  return {
    id: `response-${id}`, model: MODEL, finishReason: 'tool_calls',
    output: [{ type: 'tool_call', id, name, input: { value: 1 } }], usage: emptyUsage(),
  };
}

function runtimeTool(options: {
  name?: string;
  effect?: 'read' | 'idempotent-write' | 'side-effect';
  timeoutMs?: number;
  requiresApproval?: boolean;
  execute?: RuntimeTool['execute'];
  outputParse?: (value: unknown) => unknown;
} = {}): RuntimeTool<any, number, any> {
  return {
    descriptor: {
      name: options.name ?? 'tool', description: 'Tool.',
      input: {
        parse(value) {
          if (typeof value === 'object' && value !== null && 'value' in value) {
            return Number((value as { value: unknown }).value);
          }
          if (typeof value !== 'number') throw new TypeError('number required');
          return value;
        },
        jsonSchema: { type: 'object' },
      },
      ...(options.outputParse ? { output: { parse: options.outputParse } } : {}),
      behavior: {
        effect: options.effect,
        timeoutMs: options.timeoutMs,
        requiresApproval: options.requiresApproval,
      },
    },
    execute: options.execute ?? ((_context, input) => input * 2),
  };
}

function toolContext(signal = new AbortController().signal) {
  return { runId: 'run', callId: 'call', signal, context: undefined };
}

function validState(overrides: Partial<SerializedRunState> = {}): SerializedRunState {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: 'resume-run',
    agentId: 'agent',
    agentConfigDigest: 'digest',
    status: 'interrupted',
    trace: createRootTraceContext('resume-run'),
    startedAt,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    turn: 0,
    input: [{ type: 'text', role: 'user', text: 'x' }],
    transcript: [{ type: 'text', role: 'user', text: 'x' }],
    generatedItems: [],
    usage: emptyUsage(),
    childRunIds: [],
    metadata: {},
    ...overrides,
  };
}

function digestAgent(agent: AgentSpec): string {
  // Recompute the documented deterministic digest used at the resume boundary.
  const value = JSON.stringify({
    id: agent.id, name: agent.name, description: agent.description,
    instructions: typeof agent.instructions === 'string' ? agent.instructions : '[function]',
    model: agent.model, tools: agent.tools,
    handoffs: agent.handoffs?.map(handoff => ({ id: handoff.id, targetAgentId: handoff.targetAgentId })),
    output: agent.output ? {
      name: agent.output.name, schema: agent.output.schema, strict: agent.output.strict,
    } : undefined,
    limits: agent.limits, metadata: agent.metadata,
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function within<T>(operation: PromiseLike<T>, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(operation),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1_000);
      timer.unref?.();
    }),
  ]);
}
