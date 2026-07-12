import { describe, expect, it, vi } from 'vitest';

import {
  emptyUsage,
  type AgentSpec,
  type JsonValue,
  type RunResult,
} from '../src/core/index.js';
import {
  agentAsTool,
  agentWorkflowNode,
  BackgroundChildManager,
  ChildRunner,
  executeHandoff,
  InMemoryDurableChildStore,
  panelPreset,
  persistScope,
  restoreScope,
  reviewerPreset,
  routerPreset,
  RunTreeController,
  SemaphoreConcurrencyController,
  SharedBudgetController,
  swarmPreset,
  teamPreset,
  WorkflowGraph,
  type DurableChildRecord,
  type OrchestrationInput,
  type OrchestrationRunOptions,
  type OrchestrationRuntime,
  type OrchestrationScope,
  type WorkflowNode,
} from '../src/orchestration/index.js';
import { RuntimeServices } from '../src/runtime-v2/index.js';

type Handler = (
  agent: AgentSpec<any, any>,
  input: OrchestrationInput,
  options: OrchestrationRunOptions<any>,
) => unknown | Promise<unknown>;

describe('Orchestration boundary coverage', () => {
  it('validates every budget limit, counter, depth, token, and cost boundary', () => {
    for (const limits of [
      { maxChildRuns: -1 }, { maxDepth: 1.5 }, { maxTotalTokens: Number.POSITIVE_INFINITY },
      { maxCostUsd: -0.1 },
    ]) expect(() => new SharedBudgetController(limits)).toThrow(/must be/);

    for (const initial of [
      { childRunsStarted: -1, totalTokensUsed: 0, costUsdUsed: 0 },
      { childRunsStarted: 0.5, totalTokensUsed: 0, costUsdUsed: 0 },
      { childRunsStarted: 0, totalTokensUsed: -1, costUsdUsed: 0 },
      { childRunsStarted: 0, totalTokensUsed: 0.5, costUsdUsed: 0 },
      { childRunsStarted: 0, totalTokensUsed: 0, costUsdUsed: Number.NaN },
      { childRunsStarted: 0, totalTokensUsed: 0, costUsdUsed: -1 },
    ]) expect(() => new SharedBudgetController({}, initial)).toThrow(/counters/);

    const budget = new SharedBudgetController({
      maxChildRuns: 1, maxDepth: 1, maxTotalTokens: 2, maxCostUsd: 1,
    });
    expect(() => budget.claimChild(0)).toThrow(/positive/);
    expect(() => budget.claimChild(2)).toThrow(/maxDepth/);
    budget.claimChild(1);
    expect(() => budget.claimChild(1)).toThrow(/exhausted/);
    budget.recordUsage({ totalTokens: 2, costUsd: 1 });
    expect(() => budget.recordUsage({ totalTokens: 1, costUsd: 0 })).toThrow(/token budget/);
    const costBudget = new SharedBudgetController({ maxCostUsd: 1 });
    expect(() => costBudget.recordUsage({ totalTokens: 0, costUsd: 2 })).toThrow(/cost budget/);
    expect(SharedBudgetController.fromSnapshot(budget.snapshot()).snapshot())
      .toMatchObject({ childRunsStarted: 1, totalTokensUsed: 2, costUsdUsed: 1 });
  });

  it('keeps FIFO semaphore fairness and releases capacity on abort and failure', async () => {
    expect(() => new SemaphoreConcurrencyController(0)).toThrow(/positive/);
    expect(() => new SemaphoreConcurrencyController(1.5)).toThrow(/positive/);
    const semaphore = new SemaphoreConcurrencyController(1);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = semaphore.run(async () => { order.push('first'); await gate; return 1; }, {
      signal: new AbortController().signal,
    });
    const cancelledController = new AbortController();
    const cancelled = semaphore.run(async () => { order.push('cancelled'); return 2; }, {
      signal: cancelledController.signal,
    });
    const third = semaphore.run(async () => { order.push('third'); return 3; }, {
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(semaphore.pending).toBe(2));
    cancelledController.abort(new Error('skip waiter'));
    release();
    await expect(first).resolves.toBe(1);
    await expect(cancelled).rejects.toThrow('skip waiter');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['first', 'third']);
    expect(semaphore.active).toBe(0);
    expect(semaphore.pending).toBe(0);
    expect(semaphore.peak).toBe(1);

    const preAborted = new AbortController();
    preAborted.abort(new Error('already stopped'));
    await expect(semaphore.run(async () => 1, { signal: preAborted.signal }))
      .rejects.toThrow('already stopped');
    await expect(semaphore.run(async () => { throw new Error('operation failed'); }, {
      signal: new AbortController().signal,
    })).rejects.toThrow('operation failed');
    expect(semaphore.active).toBe(0);
  });

  it('persists, restores, validates, cancels, and prunes complete run trees', async () => {
    const services = new RuntimeServices();
    const tree = new RunTreeController();
    expect(() => tree.createRoot({ services, deadline: Number.NaN })).toThrow(/deadline/);
    expect(() => tree.createRoot({ services, securityPolicy: { id: ' ' } })).toThrow(/policy id/);
    expect(() => tree.createRoot({
      services, tenantSession: { tenantId: '', namespace: 'n' },
    })).toThrow(/Tenant id/);

    const root = tree.createRoot({
      runId: 'root', services,
      securityPolicy: { id: 'policy', attributes: { level: 'high' } },
      tenantSession: { tenantId: 'tenant', namespace: 'session', sessionId: 's' },
      workspacePolicy: { access: 'read-only', allowedRoots: ['C:/workspace'] },
      deadline: Date.now() + 10_000,
      metadata: { one: true },
    });
    expect(Object.isFrozen(root.securityPolicy.attributes)).toBe(true);
    expect(Object.isFrozen(root.workspacePolicy.allowedRoots)).toBe(true);
    expect(() => tree.createRoot({ runId: 'root', services })).toThrow(/already contains/);
    tree.adopt(root);
    const child = tree.deriveChild(root, 'child');
    expect(() => tree.deriveChild(root, 'child')).toThrow(/already contains child/);
    const grandchild = tree.deriveChild(child, 'grandchild');
    expect(tree.inspect().map(item => item.runId)).toEqual(['child', 'grandchild', 'root']);
    tree.cancelTree('missing');
    tree.complete('missing');
    tree.complete(root.runId);
    tree.complete(child.runId);
    expect(tree.inspect()).toHaveLength(3);
    tree.complete(grandchild.runId);
    expect(tree.inspect()).toHaveLength(0);

    const persisted = persistScope(root);
    const signal = new AbortController().signal;
    const concurrency = new SemaphoreConcurrencyController(2);
    const restored = restoreScope(persisted, { services, signal, concurrency });
    expect(restored.signal).toBe(signal);
    expect(restored.concurrency).toBe(concurrency);
    const restoredDefaults = restoreScope(persisted, { services });
    expect(restoredDefaults.concurrency).toBeInstanceOf(SemaphoreConcurrencyController);
    await services.close();
  });

  it('propagates pre-abort and deadline expiry into root/child scopes', async () => {
    const services = new RuntimeServices();
    const parentAbort = new AbortController();
    parentAbort.abort(new Error('parent aborted'));
    const preAborted = new RunTreeController().createRoot({
      services, signal: parentAbort.signal,
    });
    expect(preAborted.signal.aborted).toBe(true);
    const tree = new RunTreeController();
    const expiring = tree.createRoot({ runId: 'timer', services, deadline: Date.now() + 5 });
    await vi.waitFor(() => expect(expiring.signal.aborted).toBe(true));
    tree.complete(expiring.runId);
    await services.close();
  });

  it('covers agent-as-tool error data, custom mapping/context, and RuntimeTool adapter', async () => {
    const services = new RuntimeServices();
    const runtime = fakeRuntime((_agent, input) => {
      if (input === 'fail') throw Object.assign(new Error('child failed'), { code: 'CHILD' });
      return { mapped: input };
    }, services);
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const parent = rootScope(runtime, tree);
    const conversation = { owner: { agentId: 'manager', runId: parent.runId }, items: [] } as const;
    expect(() => agentAsTool(agent('child'), runner, { name: ' ' })).toThrow(/name/);
    const tool = agentAsTool(agent('child'), runner, {
      name: 'delegate',
      description: 'custom',
      mapInput: input => input === 'bad' ? 'fail' : `mapped:${String(input)}`,
      childContext: input => ({ input }),
      effect: 'read',
      metadata: { source: 'manager' },
    });
    await expect(tool.invoke({ parent, conversation, callId: ' ', input: 'x' }))
      .rejects.toThrow(/callId/);
    const failed = await tool.invoke({ parent, conversation, callId: 'call-fail', input: 'bad' });
    expect(failed.toolResult).toMatchObject({
      status: 'error', output: { error: { message: 'child failed' } },
    });
    const completed = await tool.invoke({ parent, conversation, callId: 'call-ok', input: 'ok' });
    expect(completed.toolResult).toMatchObject({ status: 'success' });

    const runtimeTool = tool.asRuntimeTool<{ scope: OrchestrationScope }>({
      scope: context => context.scope,
      managerAgentId: () => 'custom-manager',
    });
    expect(runtimeTool.descriptor.behavior?.effect).toBe('read');
    expect(runtimeTool.descriptor.input.parse?.({ valid: true })).toEqual({ valid: true });
    expect(() => runtimeTool.descriptor.input.parse?.(undefined)).toThrow(/finite/);
    await expect(runtimeTool.execute({
      context: { scope: parent }, runId: 'manager-run', callId: 'runtime-call',
      signal: new AbortController().signal,
    } as any, 'runtime')).resolves.toMatchObject({ value: expect.any(Object) });

    const defaultMap = agentAsTool(agent('default'), runner);
    await expect(defaultMap.invoke({ parent, conversation, callId: 'default-call', input: { x: 1 } }))
      .resolves.toMatchObject({ toolResult: { status: 'success' } });
    await services.close();
  });

  it('keeps handoff ownership after collected failure and validates default filtering', async () => {
    const runtime = fakeRuntime(() => { throw new Error('handoff failed'); });
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const parent = rootScope(runtime, tree);
    const conversation = {
      owner: { agentId: 'manager', runId: parent.runId },
      items: [{ type: 'text', role: 'user', text: 'hello' }] as const,
    };
    await expect(executeHandoff(runner, { id: ' ', target: agent('target') }, {
      parent, conversation,
    })).rejects.toThrow(/id/);
    const failed = await executeHandoff(runner, { id: 'handoff', target: agent('target') }, {
      parent, conversation,
    });
    expect(failed.filteredInput).toEqual(conversation.items);
    expect(failed.conversation.owner.agentId).toBe('target');
    expect(failed.conversation.items.at(-1)).toMatchObject({
      type: 'error', source: 'handoff', code: 'HANDOFF_FAILED',
    });
  });

  it('executes agent nodes and every optional preset branch', async () => {
    const runtime = fakeRuntime((_agent, input) => input);
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const scope = rootScope(runtime, tree);
    const node = agentWorkflowNode({
      id: 'agent-node', runner, agent: agent('worker'),
      input: context => String(context.input),
      context: context => ({ input: context.input }),
      effect: 'idempotent-write', idempotencyKey: () => 'key',
      failurePolicy: { mode: 'collect' }, metadata: { node: true },
    });
    await expect(node.execute?.({
      nodeId: node.id, input: 'work', scope,
      signal: scope.signal, outputs: new Map(),
    })).resolves.toMatchObject({ status: 'completed' });

    const execute = (id: string): WorkflowNode<string> => ({ id, execute: () => id });
    expect(routerPreset({
      router: execute('router'), routes: [{ node: execute('route'), when: () => true }],
    })).toBeInstanceOf(WorkflowGraph);
    expect(swarmPreset({ agents: [execute('a')], routes: [] })).toBeInstanceOf(WorkflowGraph);
    expect(() => teamPreset({ members: [], reducer: { id: 'r', reduce: () => null } }))
      .toThrow(/requires a member/);
    expect(() => panelPreset({ panelists: [], synthesize: { id: 's', reduce: () => null } }))
      .toThrow(/requires a member/);
    expect(reviewerPreset({
      author: execute('author'), reviewers: [], reducer: { id: 'reduce', reduce: () => null },
    })).toBeInstanceOf(WorkflowGraph);
  });

  it('rejects every malformed graph and propagates execute/reducer/route abort failures', async () => {
    const execute = (id: string, value: unknown = id): WorkflowNode<string> => ({ id, execute: () => value });
    expect(() => new WorkflowGraph({ nodes: [] })).toThrow(/at least one/);
    expect(() => new WorkflowGraph({ nodes: [{ id: ' ', execute: () => 1 }] })).toThrow(/id/);
    expect(() => new WorkflowGraph({ nodes: [execute('a'), execute('a')] })).toThrow(/Duplicate/);
    expect(() => new WorkflowGraph({ nodes: [{ id: 'a' }] })).toThrow(/exactly one/);
    expect(() => new WorkflowGraph({
      nodes: [{ id: 'a', execute: () => 1, reduce: () => 2 }],
    })).toThrow(/exactly one/);
    expect(() => new WorkflowGraph({
      nodes: [execute('a')], edges: [{ from: 'a', to: 'missing' }],
    })).toThrow(/unknown node/);
    expect(() => new WorkflowGraph({
      nodes: [execute('a')], edges: [{ from: 'a', to: 'a' }],
    })).toThrow(/cannot depend on itself/);
    expect(() => new WorkflowGraph({
      nodes: [execute('a'), execute('b')],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
    })).toThrow(/Duplicate workflow edge/);
    expect(() => new WorkflowGraph({
      nodes: [{ id: 'reduce', reduce: () => 1 }],
    })).toThrow(/requires at least one predecessor/);

    const runtime = fakeRuntime(() => null);
    const scope = rootScope(runtime);
    const graph = new WorkflowGraph<string>({
      nodes: [
        { id: 'source', execute: () => 'value' },
        { id: 'skip-a', execute: () => 'a' },
        { id: 'skip-b', execute: () => 'b' },
        { id: 'any', activation: 'any', reduce: ({ inputs }) => inputs.size },
      ],
      edges: [
        { from: 'source', to: 'skip-a', when: () => false },
        { from: 'source', to: 'skip-b', when: async () => false },
        { from: 'skip-a', to: 'any' }, { from: 'skip-b', to: 'any' },
      ],
    });
    const result = await graph.execute({ input: 'x', scope });
    expect(Object.fromEntries(result.statuses)).toMatchObject({
      source: 'completed', 'skip-a': 'skipped', 'skip-b': 'skipped', any: 'skipped',
    });
    await expect(graph.execute({ input: 'x', scope, maxConcurrency: 0 })).rejects.toThrow(/positive/);

    const abortedController = new AbortController();
    abortedController.abort(new Error('workflow pre-abort'));
    const abortedScope = { ...scope, signal: abortedController.signal };
    await expect(graph.execute({ input: 'x', scope: abortedScope })).rejects.toThrow('workflow pre-abort');

    const failing = new WorkflowGraph({ nodes: [{ id: 'fail', execute: () => { throw new Error('node'); } }] });
    await expect(failing.execute({ input: undefined, scope })).rejects.toMatchObject({
      name: 'WorkflowNodeExecutionError', nodeId: 'fail', cause: expect.any(Error),
    });
  });

  it('covers durable store cloning, ordering, CAS, validation, and terminal result paths', async () => {
    const runtime = fakeRuntime((_agent, input) => input);
    const services = runtime.services;
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const parent = rootScope(runtime, tree);
    const store = new InMemoryDurableChildStore();
    let now = 1_000;
    const manager = new BackgroundChildManager({
      runner, store, resolveAgent: id => id === 'worker' ? agent('worker') : undefined,
      ownerId: 'owner', leaseMs: 100, now: () => now,
    });
    expect(() => new BackgroundChildManager({
      runner, store, resolveAgent: () => undefined, leaseMs: 0,
    })).toThrow(/leaseMs/);
    await expect(manager.query('missing')).rejects.toThrow(/Unknown/);

    const queued = await manager.spawn({
      parent, agent: agent('worker'), input: { type: 'text', role: 'user', text: 'single' },
      childId: 'queued', autoStart: false,
    });
    await expect(store.create(await queued.query())).rejects.toThrow(/already exists/);
    const record = await queued.query();
    expect(await store.compareAndSet('missing', 0, record)).toBe(false);
    expect(await store.compareAndSet('queued', 1, record)).toBe(false);
    await expect(store.compareAndSet('queued', 0, { ...record, revision: 2 }))
      .rejects.toThrow(/exactly one/);
    expect(await store.list('other')).toEqual([]);
    expect((await store.list(parent.runId)).map(item => item.childId)).toEqual(['queued']);
    await expect(queued.result()).rejects.toThrow(/call resume/);
    await queued.resume();
    await expect(queued.result()).resolves.toMatchObject({ output: expect.any(Object) });
    await expect(queued.resume()).resolves.toBe(queued);
    await expect(queued.cancel()).resolves.toBeUndefined();

    const cancelled = await manager.spawn({
      parent, agent: agent('worker'), input: ['array'] as any,
      childId: 'cancelled', autoStart: false,
    });
    await cancelled.cancel('user cancelled');
    await cancelled.cancel('already cancelled');
    await expect(cancelled.result()).rejects.toThrow(/cancelled/);
    await expect(cancelled.resume()).resolves.toBe(cancelled);
    await expect(cancelled.result()).rejects.toThrow(/cancelled/);

    await expect(manager.spawn({
      parent, agent: agent('worker'), input: 'x', childId: 'retry-count', autoStart: false,
      effect: 'read', failurePolicy: { mode: 'retry-safe', maxAttempts: 1 },
    })).rejects.toThrow(/at least 2/);
    await expect(manager.spawn({
      parent, agent: agent('worker'), input: 'x', childId: 'retry-side', autoStart: false,
      effect: 'side-effect', failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    })).rejects.toThrow(/cannot replay/);
    await expect(manager.spawn({
      parent, agent: agent('worker'), input: 'x', childId: 'retry-key', autoStart: false,
      effect: 'idempotent-write', failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    })).rejects.toThrow(/idempotencyKey/);

    const otherServices = new RuntimeServices();
    const otherParent = new RunTreeController().createRoot({ services: otherServices });
    await expect(manager.spawn({ parent: otherParent, agent: agent('worker'), input: 'x' }))
      .rejects.toThrow(/share/);
    await expect(manager.spawn({
      parent, agent: agent('worker'), input: 'x', context: undefined as any,
      childId: 'undefined-context', autoStart: false,
    })).resolves.toBeDefined();
    await services.close();
    await otherServices.close();
  });

  it('rejects active/stale unsafe leases and records missing-agent or child failures', async () => {
    const services = new RuntimeServices();
    const failingRuntime = fakeRuntime(() => { throw new Error('runner failure'); }, services);
    const tree = new RunTreeController();
    const parent = rootScope(failingRuntime, tree);
    const store = new InMemoryDurableChildStore();
    let now = 100;
    const manager = new BackgroundChildManager({
      runner: new ChildRunner(failingRuntime, tree), store,
      resolveAgent: id => id === 'fail' ? agent('fail') : undefined,
      ownerId: 'owner', leaseMs: 10, now: () => now,
    });
    const missing = await manager.spawn({
      parent, agent: agent('missing'), input: 'x', childId: 'missing-agent', autoStart: false,
    });
    await missing.resume();
    await expect(missing.result()).rejects.toThrow(/Cannot resolve/);
    await expect(missing.result()).rejects.toThrow(/failed/);

    const failed = await manager.spawn({
      parent, agent: agent('fail'), input: 'x', childId: 'failed-child', autoStart: false,
    });
    await failed.resume();
    await expect(failed.result()).rejects.toThrow(/failed after 1 attempt/);

    for (const [id, effect, idempotencyKey, expiresAt, expected] of [
      ['active', 'read', undefined, 200, /leased/],
      ['stale-side', 'side-effect', undefined, 0, /may have committed/],
      ['stale-write', 'idempotent-write', undefined, 0, /may have committed/],
    ] as const) {
      const handle = await manager.spawn({
        parent, agent: agent('fail'), input: 'x', childId: id, autoStart: false,
        effect, idempotencyKey,
      });
      const current = await handle.query();
      await store.compareAndSet(id, current.revision, {
        ...current, revision: current.revision + 1, status: 'running',
        attempts: 1, leaseOwner: 'other', leaseExpiresAt: expiresAt,
      });
      await handle.resume();
      await expect(handle.result()).rejects.toThrow(expected);
    }
    now = 300;
    await services.close();
  });
});

function fakeRuntime(handler: Handler, services = new RuntimeServices()): OrchestrationRuntime {
  return {
    services,
    run: async <TContext, TOutput>(
      spec: AgentSpec<TContext, TOutput>,
      input: OrchestrationInput,
      options: OrchestrationRunOptions<TContext> = {},
    ): Promise<RunResult<TOutput>> => {
      const output = await handler(spec, input, options) as TOutput;
      const at = new Date().toISOString();
      return {
        runId: options.runId ?? `run-${spec.id}`,
        agentId: spec.id,
        status: 'completed',
        output,
        items: [{ type: 'text', role: 'assistant', text: JSON.stringify(output) }],
        usage: emptyUsage(),
        startedAt: at,
        completedAt: at,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      };
    },
  };
}

function rootScope(runtime: OrchestrationRuntime, tree = new RunTreeController()): OrchestrationScope {
  return tree.createRoot({ runId: `root-${Math.random()}`, services: runtime.services });
}

function agent(id: string): AgentSpec<any, JsonValue> {
  return { id, name: id, instructions: `You are ${id}.` };
}
