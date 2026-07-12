import { describe, expect, it, vi } from 'vitest';

import type { AgentSpec, InputItem, Usage } from '../src/core/index.js';
import {
  ChildRunner,
  RunTreeController,
  executeHandoff,
} from '../src/orchestration/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  mergeModelCapabilities,
  type ModelCallContext,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStream,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import {
  AgentRuntime,
  MiddlewareInvariantViolationError,
  MiddlewareStage,
  MiddlewareRegistry,
  RuntimeServices,
  ToolRegistry,
  defineMiddleware,
  type RuntimeMiddlewareContext,
  type RuntimeHandoffMiddlewareContext,
  type RuntimeTool,
} from '../src/runtime-v2/index.js';

const FULL_CAPABILITIES = mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, {
  input: { image: true, audio: true, document: true, artifact: true },
  output: { image: true, audio: true, structured: true },
  tools: { function: true, parallel: true, hosted: true },
  reasoning: { request: true, opaqueRoundTrip: true },
  streaming: true,
  promptCaching: true,
  stopSequences: true,
  providerRawRoundTrip: true,
});

class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly respond: (
      request: ModelRequest,
      context: ModelCallContext,
      index: number,
    ) => Promise<ModelResponse> | ModelResponse,
  ) {}

  async resolve(ref: AgentSpec['model']): Promise<ResolvedModel> {
    const modelId = typeof ref === 'string'
      ? ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
      : ref?.model ?? 'model';
    return { providerId: this.id, modelId, ref: { provider: this.id, model: modelId } };
  }

  async capabilities() {
    return FULL_CAPABILITIES;
  }

  async generate(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse> {
    this.requests.push(request);
    return this.respond(request, context, this.requests.length - 1);
  }

  stream(request: ModelRequest, context: ModelCallContext): ModelStream {
    this.requests.push(request);
    const pending = Promise.resolve(this.respond(request, context, this.requests.length - 1));
    let cancelled = false;
    return {
      cancel: () => { cancelled = true; },
      finalResponse: () => pending,
      async *[Symbol.asyncIterator]() {
        const value = await pending;
        if (cancelled) return;
        for (const item of value.output) {
          if (item.type === 'text') yield { type: 'text.delta' as const, delta: item.text };
        }
        yield { type: 'response.completed' as const, response: value };
      },
    };
  }
}

function usage(values: Partial<Usage> = {}): Usage {
  return {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: (values.inputTokens ?? 0) + (values.outputTokens ?? 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
    ...values,
  };
}

function response(
  output: ModelResponse['output'],
  model: ResolvedModel,
  values: Partial<ModelResponse> = {},
): ModelResponse {
  return {
    id: `response-${Math.random()}`,
    model,
    output,
    finishReason: 'stop',
    usage: usage(),
    ...values,
  };
}

const fakeModel: ResolvedModel = {
  providerId: 'fake',
  modelId: 'model',
  ref: { provider: 'fake', model: 'model' },
};

const textAgent: AgentSpec = {
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Answer briefly.',
  model: 'fake:model',
};

describe('AgentRuntime v2', () => {
  it('runs a minimal text agent without initializing optional services', async () => {
    const memoryFactory = vi.fn(() => ({ close: vi.fn() }));
    const services = new RuntimeServices({ memory: { factory: memoryFactory } });
    const provider: FakeProvider = new FakeProvider(() => {
      return response([{ type: 'text', role: 'assistant', text: 'hello' }], fakeModel, {
        usage: usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      });
    });
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]), services });

    const result = await runtime.run(textAgent, 'hi');

    expect(result).toMatchObject({ status: 'completed', output: 'hello' });
    expect(provider.requests[0]?.input).toEqual([
      { type: 'text', role: 'system', text: 'Answer briefly.' },
      { type: 'text', role: 'user', text: 'hi' },
    ]);
    expect(memoryFactory).not.toHaveBeenCalled();
    expect(services.isInitialized('memory')).toBe(false);
    await runtime.close();
    expect(memoryFactory).not.toHaveBeenCalled();
  });

  it('keeps the loop state-machine focused and aggregates every model call usage', async () => {
    const provider: FakeProvider = new FakeProvider((_request, _context, index) => {
      if (index === 0) {
        return response([{
          type: 'tool_call', id: 'call-1', name: 'double', input: { value: 3 },
        }], fakeModel, {
          finishReason: 'tool_calls',
          usage: usage({ inputTokens: 4, outputTokens: 2, totalTokens: 6, cacheReadTokens: 1 }),
        });
      }
      return response([{ type: 'text', role: 'assistant', text: '6' }], fakeModel, {
        usage: usage({ inputTokens: 7, outputTokens: 1, totalTokens: 8, reasoningTokens: 2 }),
      });
    });
    const double: RuntimeTool<unknown, { value: number }, number> = {
      descriptor: {
        name: 'double',
        description: 'Double a number.',
        input: {
          jsonSchema: { type: 'object', required: ['value'] },
          parse(value) {
            if (typeof value !== 'object' || value === null || typeof (value as { value?: unknown }).value !== 'number') {
              throw new TypeError('value must be a number');
            }
            return value as { value: number };
          },
        },
        behavior: { effect: 'read' },
      },
      execute: (_context, input) => input.value * 2,
    };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools: new ToolRegistry([double]),
    });

    const result = await runtime.run({ ...textAgent, tools: ['double'] }, 'calculate');

    expect(result.output).toBe('6');
    expect(result.usage).toMatchObject({
      requests: 2,
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      cacheReadTokens: 1,
      reasoningTokens: 2,
    });
    expect(provider.requests[1]?.input).toContainEqual({
      type: 'tool_result', callId: 'call-1', name: 'double', status: 'success', output: 6,
    });
    await runtime.close();
  });

  it('runs bounded read-only tool batches concurrently and preserves call order', async () => {
    const resolvers = new Map<string, (value: string) => void>();
    let active = 0;
    let peak = 0;
    const readTool = (name: string): RuntimeTool<unknown, Record<string, never>, string> => ({
      descriptor: {
        name,
        description: name,
        input: { parse: () => ({}), jsonSchema: { type: 'object' } },
        behavior: { effect: 'read' },
      },
      execute: () => new Promise<string>(resolve => {
        active += 1;
        peak = Math.max(peak, active);
        resolvers.set(name, value => {
          active -= 1;
          resolve(value);
        });
      }),
    });
    const provider: FakeProvider = new FakeProvider((_request, _context, index) => index === 0
      ? response([
          { type: 'tool_call', id: 'a', name: 'read-a', input: {} },
          { type: 'tool_call', id: 'b', name: 'read-b', input: {} },
        ], fakeModel, { finishReason: 'tool_calls' })
      : response([{ type: 'text', role: 'assistant', text: 'done' }], fakeModel));
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools: new ToolRegistry([readTool('read-a'), readTool('read-b')]),
    });
    const running = runtime.run({
      ...textAgent,
      tools: ['read-a', 'read-b'],
      limits: { maxParallelTools: 2 },
    }, 'read');
    while (resolvers.size < 2) await Promise.resolve();

    resolvers.get('read-b')?.('B');
    resolvers.get('read-a')?.('A');
    await expect(running).resolves.toMatchObject({ output: 'done' });

    expect(peak).toBe(2);
    expect(provider.requests[1]?.input.filter(item => item.type === 'tool_result'))
      .toMatchObject([
        { callId: 'a', output: 'A' },
        { callId: 'b', output: 'B' },
      ]);
    await runtime.close();
  });

  it('supports typed structured output through the same runtime', async () => {
    const provider: FakeProvider = new FakeProvider(() => {
      return response([
        { type: 'structured', role: 'assistant', schemaName: 'answer', value: { answer: 42 } },
      ], fakeModel, { structuredOutput: { answer: 42 } });
    });
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]) });
    const agent: AgentSpec<unknown, { answer: number }> = {
      id: textAgent.id,
      name: textAgent.name,
      instructions: textAgent.instructions,
      model: textAgent.model,
      output: {
        name: 'answer',
        schema: { type: 'object', required: ['answer'] },
        parse(value) {
          return value as { answer: number };
        },
      },
    };

    await expect(runtime.run(agent, 'answer')).resolves.toMatchObject({ output: { answer: 42 } });
    expect(provider.requests[0]?.outputSchema?.name).toBe('answer');
    await runtime.close();
  });

  it('consumes provider streaming deltas through the bounded RunEvent channel', async () => {
    const provider: FakeProvider = new FakeProvider(() => response([
      { type: 'text', role: 'assistant', text: 'streamed' },
    ], fakeModel));
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]) });
    const handle = runtime.stream(textAgent, 'hi');
    const deltas: string[] = [];
    for await (const event of handle) {
      if (event.type === 'model.text.delta') {
        deltas.push((event.data as { delta: string }).delta);
      }
    }

    await expect(handle.result).resolves.toMatchObject({ output: 'streamed' });
    expect(deltas.join('')).toBe('streamed');
    await runtime.close();
  });

  it('executes inspectable middleware in deterministic onion order', async () => {
    const order: string[] = [];
    const provider: FakeProvider = new FakeProvider(() => {
      return response([{ type: 'text', role: 'assistant', text: 'ok' }], fakeModel);
    });
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      middleware: [
        defineMiddleware<MiddlewareStage.WrapModelCall, RuntimeMiddlewareContext, ModelResponse>({
          name: 'outer', stage: MiddlewareStage.WrapModelCall, priority: 10,
          handle: async (_context, next) => {
            order.push('outer.before');
            const value = await next();
            order.push('outer.after');
            return value;
          },
        }),
        defineMiddleware<MiddlewareStage.WrapModelCall, RuntimeMiddlewareContext, ModelResponse>({
          name: 'inner', stage: MiddlewareStage.WrapModelCall, priority: 20,
          handle: async (_context, next) => {
            order.push('inner.before');
            const value = await next();
            order.push('inner.after');
            return value;
          },
        }),
      ],
    });

    await runtime.run(textAgent, 'hi');
    expect(order).toEqual(['outer.before', 'inner.before', 'inner.after', 'outer.after']);
    expect(runtime.inspectMiddleware()).toContain('wrapModelCall[0] @10 outer');
    await runtime.close();
  });

  it('rejects middleware that tries to bypass provider or ToolRunner invariants', async () => {
    const modelProvider = new FakeProvider(() => response([
      { type: 'text', role: 'assistant', text: 'transport' },
    ], fakeModel));
    const modelRuntime = new AgentRuntime({
      models: new ModelRegistry([modelProvider]),
      middleware: [
        defineMiddleware<MiddlewareStage.WrapModelCall, RuntimeMiddlewareContext, ModelResponse>({
          name: 'forged-model-cache',
          stage: MiddlewareStage.WrapModelCall,
          priority: 0,
          handle: async () => response([
            { type: 'text', role: 'assistant', text: 'forged' },
          ], fakeModel),
        }),
      ],
    });

    await expect(modelRuntime.run(textAgent, 'hi'))
      .rejects.toBeInstanceOf(MiddlewareInvariantViolationError);
    expect(modelProvider.requests).toHaveLength(0);
    await modelRuntime.close();

    const afterProvider = new FakeProvider(() => response([
      { type: 'text', role: 'assistant', text: 'transport' },
    ], fakeModel));
    const afterRuntime = new AgentRuntime({
      models: new ModelRegistry([afterProvider]),
      middleware: [
        defineMiddleware<MiddlewareStage.AfterModelResponse, RuntimeMiddlewareContext, ModelResponse>({
          name: 'invalid-model-rewriter',
          stage: MiddlewareStage.AfterModelResponse,
          priority: 0,
          handle: async (_context, next) => ({
            ...await next(),
            output: [{ type: 'unknown-item' } as never],
          }),
        }),
      ],
    });

    await expect(afterRuntime.run(textAgent, 'hi'))
      .rejects.toBeInstanceOf(MiddlewareInvariantViolationError);
    expect(afterProvider.requests).toHaveLength(1);
    await afterRuntime.close();

    const toolProvider = new FakeProvider((_request, _context, index) => index === 0
      ? response([{
          type: 'tool_call', id: 'protected-call', name: 'protected-read', input: {},
        }], fakeModel, { finishReason: 'tool_calls' })
      : response([{ type: 'text', role: 'assistant', text: 'done' }], fakeModel));
    const execute = vi.fn(() => 'real');
    const authorize = vi.fn(() => ({ type: 'allow' as const }));
    const protectedTool: RuntimeTool = {
      descriptor: {
        name: 'protected-read',
        description: 'A policy-protected read.',
        input: { parse: () => ({}), jsonSchema: { type: 'object' } },
        behavior: { effect: 'read' },
      },
      execute,
    };
    const toolRuntime = new AgentRuntime({
      models: new ModelRegistry([toolProvider]),
      tools: new ToolRegistry([protectedTool]),
      toolPolicy: { authorize },
      middleware: [
        defineMiddleware<MiddlewareStage.WrapToolCall, RuntimeMiddlewareContext, { value: string }>({
          name: 'forged-tool-result',
          stage: MiddlewareStage.WrapToolCall,
          priority: 0,
          handle: async () => ({ value: 'forged' }),
        }),
      ],
    });

    await expect(toolRuntime.run({ ...textAgent, tools: ['protected-read'] }, 'read'))
      .rejects.toBeInstanceOf(MiddlewareInvariantViolationError);
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await toolRuntime.close();
  });

  it('parses tool output once and rejects replacement after ToolRunner returns', async () => {
    const providerForTool = () => new FakeProvider((_request, _context, index) => index === 0
      ? response([{
          type: 'tool_call', id: 'normalize-call', name: 'normalize', input: {},
        }], fakeModel, { finishReason: 'tool_calls' })
      : response([{ type: 'text', role: 'assistant', text: 'done' }], fakeModel));
    const parse = vi.fn((value: unknown) => {
      if (typeof value !== 'string') throw new TypeError('expected raw string');
      return { normalized: value };
    });
    const execute = vi.fn(() => 'raw-value');
    const tool: RuntimeTool<unknown, Record<string, never>, unknown> = {
      descriptor: {
        name: 'normalize',
        description: 'Normalize one raw value.',
        input: { parse: () => ({}), jsonSchema: { type: 'object' } },
        output: { parse },
        behavior: { effect: 'side-effect' },
      },
      execute,
    };
    const observed: unknown[] = [];
    const runtime = new AgentRuntime({
      models: new ModelRegistry([providerForTool()]),
      tools: new ToolRegistry([tool]),
      middleware: [
        defineMiddleware<MiddlewareStage.WrapToolCall, RuntimeMiddlewareContext, { value: unknown }>({
          name: 'tool-observer',
          stage: MiddlewareStage.WrapToolCall,
          priority: 0,
          handle: async (_context, next) => {
            const output = await next();
            observed.push(output.value);
            return output;
          },
        }),
      ],
    });

    await expect(runtime.run({ ...textAgent, tools: ['normalize'] }, 'normalize'))
      .resolves.toMatchObject({ output: 'done' });
    expect(parse).toHaveBeenCalledOnce();
    expect(observed).toEqual([{ normalized: 'raw-value' }]);
    await runtime.close();

    const replacementRuntime = new AgentRuntime({
      models: new ModelRegistry([providerForTool()]),
      tools: new ToolRegistry([tool]),
      middleware: [
        defineMiddleware<MiddlewareStage.WrapToolCall, RuntimeMiddlewareContext, { value: unknown }>({
          name: 'tool-rewriter',
          stage: MiddlewareStage.WrapToolCall,
          priority: 0,
          handle: async (_context, next) => {
            await next();
            return { value: { normalized: 'forged' } };
          },
        }),
      ],
    });

    await expect(replacementRuntime.run({ ...textAgent, tools: ['normalize'] }, 'normalize'))
      .rejects.toBeInstanceOf(MiddlewareInvariantViolationError);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    await replacementRuntime.close();
  });

  it('executes beforeHandoff on the explicit ownership-transfer path', async () => {
    const seen: Array<{
      sourceAgentId: string;
      targetAgentId: string;
      parentRunId: string;
      handoffId: string;
    }> = [];
    const provider = new FakeProvider(() => response([
      { type: 'text', role: 'assistant', text: 'accepted' },
    ], fakeModel));
    const source: AgentSpec = {
      ...textAgent,
      id: 'manager',
      name: 'Manager',
      handoffs: [{ id: 'to-specialist', targetAgentId: 'specialist' }],
    };
    const target: AgentSpec = {
      ...textAgent,
      id: 'specialist',
      name: 'Specialist',
    };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      agents: [source, target],
      middleware: [
        defineMiddleware<
          MiddlewareStage.BeforeHandoff,
          RuntimeHandoffMiddlewareContext,
          readonly InputItem[]
        >({
          name: 'handoff-audit',
          stage: MiddlewareStage.BeforeHandoff,
          priority: 0,
          handle: async (context, next) => {
            seen.push({
              sourceAgentId: context.sourceAgentId,
              targetAgentId: context.targetAgent.id,
              parentRunId: context.parentRunId,
              handoffId: context.handoffId,
            });
            const input = await next();
            return [...input, { type: 'text', role: 'user', text: 'middleware-approved' }];
          },
        }),
      ],
    });
    const tree = new RunTreeController();
    const parent = tree.createRoot({
      runId: 'manager-run',
      services: runtime.services,
      tenantSession: { tenantId: 'tenant-a', namespace: 'handoff-test' },
    });
    const result = await executeHandoff(new ChildRunner(runtime, tree), {
      id: 'to-specialist',
      target,
      inputFilter: () => [{ type: 'text', role: 'user', text: 'filtered' }],
    }, {
      parent,
      conversation: {
        owner: { agentId: source.id, runId: parent.runId },
        items: [{ type: 'text', role: 'user', text: 'original' }],
      },
    });

    expect(seen).toEqual([{
      sourceAgentId: 'manager',
      targetAgentId: 'specialist',
      parentRunId: 'manager-run',
      handoffId: 'to-specialist',
    }]);
    expect(result.filteredInput).toEqual([
      { type: 'text', role: 'user', text: 'filtered' },
      { type: 'text', role: 'user', text: 'middleware-approved' },
    ]);
    expect(result).toMatchObject({
      ownershipTransferred: true,
      ownerAfter: { agentId: 'specialist' },
      child: { status: 'completed', result: { output: 'accepted' } },
    });
    await runtime.close();
  });

  it('resolves AgentSpec middleware refs and rejects unknown refs before transport', async () => {
    const invoked: string[] = [];
    const provider: FakeProvider = new FakeProvider(() => response([
      { type: 'text', role: 'assistant', text: 'ok' },
    ], fakeModel));
    const middlewareRegistry = new MiddlewareRegistry({
      'agent.prompt': defineMiddleware({
        name: 'agent-prompt',
        stage: MiddlewareStage.BeforeRun,
        priority: 50,
        handle: async (_context, next) => {
          invoked.push('agent.prompt');
          return next();
        },
      }),
    });
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      middlewareRegistry,
    });

    await runtime.run({ ...textAgent, middleware: ['agent.prompt'] }, 'hi');
    expect(invoked).toEqual(['agent.prompt']);
    expect(runtime.inspectMiddleware({ ...textAgent, middleware: ['agent.prompt'] })).toContain('agent-prompt');
    await expect(runtime.run({ ...textAgent, id: 'bad', middleware: ['missing'] }, 'hi'))
      .rejects.toThrow(/Unknown middleware reference/);
    expect(provider.requests).toHaveLength(1);
    await runtime.close();
  });

  it('cancels a provider that ignores AbortSignal and emits a terminal event', async () => {
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    const provider: FakeProvider = new FakeProvider(() => {
      started();
      return new Promise<ModelResponse>(() => undefined);
    });
    const runtime = new AgentRuntime({ models: new ModelRegistry([provider]) });
    const handle = runtime.stream(textAgent, 'wait');
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of handle) events.push(event.type);
    })();
    await providerStarted;

    handle.cancel('stop now');

    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' });
    await consume;
    expect(events).toContain('run.cancelled');
    await runtime.close();
  });

  it('persists approval interruption state and resumes without replaying a committed side effect', async () => {
    const provider: FakeProvider = new FakeProvider((_request, _context, index) => {
      return index === 0
        ? response([{ type: 'tool_call', id: 'write-1', name: 'write', input: { value: 'x' } }], fakeModel, {
            finishReason: 'tool_calls',
          })
        : response([{ type: 'text', role: 'assistant', text: 'written' }], fakeModel);
    });
    const execute = vi.fn(() => ({ ok: true }));
    const write: RuntimeTool<unknown, { value: string }, { ok: boolean }> = {
      descriptor: {
        name: 'write', description: 'Side effect.',
        input: { parse: value => value as { value: string }, jsonSchema: { type: 'object' } },
        behavior: { effect: 'side-effect', requiresApproval: true },
      },
      execute,
    };
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools: new ToolRegistry([write]),
    });
    const handle = runtime.stream({ ...textAgent, tools: ['write'] }, 'write');
    await expect(handle.result).resolves.toMatchObject({ status: 'interrupted' });
    const state = await handle.snapshot();
    expect(state.pendingTool).toMatchObject({ status: 'awaiting_approval', effect: 'side-effect' });
    expect(execute).not.toHaveBeenCalled();

    const resumed = runtime.resume(state, [{
      interruptionId: state.pendingTool?.interruptionId ?? '', outcome: 'approve',
    }]);
    await expect(resumed.result).resolves.toMatchObject({ status: 'completed', output: 'written' });
    expect(execute).toHaveBeenCalledTimes(1);
    const completed = await resumed.snapshot();
    expect(completed.pendingTool).toBeUndefined();
    await runtime.close();
  });
});
