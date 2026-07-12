import { describe, expect, it, vi } from 'vitest';

import {
  emptyUsage,
  type AgentSpec,
  type JsonValue,
  type OutputItem,
  type RunResult,
} from '../src/core/index.js';
import { RuntimeServices } from '../src/runtime-v2/services.js';
import {
  agentAsTool,
  BackgroundChildManager,
  ChildRunError,
  ChildRunner,
  executeHandoff,
  InMemoryDurableChildStore,
  panelPreset,
  reviewerPreset,
  routerPreset,
  RunTreeController,
  SemaphoreConcurrencyController,
  SharedBudgetController,
  swarmPreset,
  teamPreset,
  WorkflowGraph,
  type OrchestrationInput,
  type OrchestrationRunOptions,
  type OrchestrationRuntime,
  type OrchestrationScope,
  type WorkflowNode,
} from '../src/orchestration/index.js';

interface FakeResponse {
  readonly output: unknown;
  readonly items?: readonly OutputItem[];
  readonly usage?: ReturnType<typeof emptyUsage>;
}

type FakeHandler = (
  agent: AgentSpec<any, any>,
  input: OrchestrationInput,
  options: OrchestrationRunOptions<any>,
) => Promise<FakeResponse> | FakeResponse;

function fakeRuntime(
  handler: FakeHandler,
  services = new RuntimeServices(),
): OrchestrationRuntime {
  return {
    services,
    run: async <TContext, TOutput>(
      agent: AgentSpec<TContext, TOutput>,
      input: OrchestrationInput,
      options: OrchestrationRunOptions<TContext> = {},
    ): Promise<RunResult<TOutput>> => {
      const response = await handler(agent, input, options);
      const startedAt = new Date().toISOString();
      return {
        runId: options.runId ?? `run-${agent.id}`,
        agentId: agent.id,
        status: 'completed',
        output: response.output as TOutput,
        items: response.items ?? [{
          type: 'text',
          role: 'assistant',
          text: String(response.output),
        }],
        usage: response.usage ?? emptyUsage(),
        startedAt,
        completedAt: new Date().toISOString(),
        sessionId: options.sessionId,
        metadata: options.metadata,
      };
    },
  };
}

function jsonAgent(id: string): AgentSpec<unknown, JsonValue> {
  return { id, name: id, instructions: `You are ${id}.` };
}

function rootScope(
  runtime: OrchestrationRuntime,
  tree = new RunTreeController(),
  overrides: Partial<Parameters<RunTreeController['createRoot']>[0]> = {},
): OrchestrationScope {
  return tree.createRoot({
    runId: 'manager-run',
    services: runtime.services,
    tenantSession: { tenantId: 'tenant-a', namespace: 'chat', sessionId: 'session-main' },
    ...overrides,
  });
}

describe('unified orchestration primitives', () => {
  it('keeps manager conversation ownership for agent-as-tool but transfers it for handoff', async () => {
    const calls: Array<{ agentId: string; input: OrchestrationInput; options: OrchestrationRunOptions }> = [];
    const runtime = fakeRuntime((agent, input, options) => {
      calls.push({ agentId: agent.id, input, options });
      return { output: `${agent.id}-done` };
    });
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const parent = rootScope(runtime, tree);
    const conversation = {
      owner: { agentId: 'manager', runId: parent.runId },
      items: [{ type: 'text', role: 'user', text: 'original' }] as const,
    };
    const specialist = jsonAgent('specialist');

    const tool = agentAsTool(specialist, runner, { name: 'ask_specialist' });
    const delegated = await tool.invoke({
      parent,
      conversation,
      callId: 'call-1',
      input: { question: 'check this' },
    });

    expect(delegated.ownerBefore).toBe(conversation.owner);
    expect(delegated.ownerAfter).toBe(conversation.owner);
    expect(delegated.conversation.owner.agentId).toBe('manager');
    expect(delegated.conversation.items).toHaveLength(2);
    expect(delegated.conversation.items[1]).toMatchObject({
      type: 'tool_result',
      callId: 'call-1',
      status: 'success',
      output: { agentId: 'specialist', output: 'specialist-done' },
    });
    expect(calls[0]?.options.sessionId).not.toBe('session-main');

    const handedOff = await executeHandoff(runner, {
      id: 'transfer-to-specialist',
      target: specialist,
      inputFilter: items => [{ ...items[0]!, text: 'filtered' }],
    }, { parent, conversation });

    expect(handedOff.ownershipTransferred).toBe(true);
    expect(handedOff.ownerBefore).toBe(conversation.owner);
    expect(handedOff.ownerAfter.agentId).toBe('specialist');
    expect(handedOff.ownerAfter.runId).not.toBe(parent.runId);
    expect(handedOff.conversation.owner).toEqual(handedOff.ownerAfter);
    expect(handedOff.filteredInput).toEqual([{ type: 'text', role: 'user', text: 'filtered' }]);
    expect(handedOff.conversation.items.some(item => item.type === 'tool_result')).toBe(false);
    expect(calls[1]?.options.sessionId).toBe('session-main');
  });

  it('shares one RuntimeServices collection and every inherited boundary across ten children', async () => {
    const providerFactory = vi.fn(() => ({ close: vi.fn() }));
    const mcpFactory = vi.fn(() => ({ close: vi.fn() }));
    const sessionFactory = vi.fn(() => ({ close: vi.fn() }));
    const services = new RuntimeServices({
      provider: { factory: providerFactory },
      mcp: { factory: mcpFactory },
      session: { factory: sessionFactory },
    });
    const seenScopes: OrchestrationScope[] = [];
    const seenServiceInstances: unknown[][] = [];
    const runtime = fakeRuntime(async (_agent, _input, options) => {
      const scope = options.orchestration!;
      seenScopes.push(scope);
      seenServiceInstances.push(await Promise.all([
        scope.services.resolve('provider'),
        scope.services.resolve('mcp'),
        scope.services.resolve('session'),
      ]));
      return { output: scope.runId };
    }, services);
    const tree = new RunTreeController();
    const securityPolicy = { id: 'locked', version: '2' } as const;
    const workspacePolicy = {
      workspaceId: 'workspace-a',
      root: 'C:/workspace',
      access: 'read-only' as const,
      allowedRoots: ['C:/workspace'],
    };
    const budget = new SharedBudgetController({ maxChildRuns: 10, maxDepth: 3 });
    const concurrency = new SemaphoreConcurrencyController(10);
    const deadline = Date.now() + 60_000;
    const parent = rootScope(runtime, tree, {
      deadline,
      securityPolicy,
      workspacePolicy,
      budget,
      concurrency,
      metadata: { classification: 'internal' },
    });
    const runner = new ChildRunner(runtime, tree);

    await Promise.all(Array.from({ length: 10 }, (_, index) => runner.run({
      parent,
      agent: jsonAgent(`member-${index}`),
      input: `task-${index}`,
    })));

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(mcpFactory).toHaveBeenCalledTimes(1);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(seenScopes).toHaveLength(10);
    for (const scope of seenScopes) {
      expect(scope.services).toBe(services);
      expect(scope.securityPolicy).toBe(parent.securityPolicy);
      expect(scope.tenantSession).toBe(parent.tenantSession);
      expect(scope.workspacePolicy).toBe(parent.workspacePolicy);
      expect(scope.budget).toBe(budget);
      expect(scope.concurrency).toBe(concurrency);
      expect(scope.deadline).toBe(deadline);
      expect(scope.trace.traceId).toBe(parent.trace.traceId);
      expect(scope.trace.parentSpanId).toBe(parent.trace.spanId);
    }
    expect(seenServiceInstances.every(value => value[0] === seenServiceInstances[0]?.[0])).toBe(true);
    expect(budget.snapshot().childRunsStarted).toBe(10);
    await services.close();
  });

  it('cancels every descendant when the parent tree is cancelled', async () => {
    const scopes: OrchestrationScope[] = [];
    const runtime = fakeRuntime((_agent, _input, options) => {
      const scope = options.orchestration!;
      scopes.push(scope);
      return new Promise<FakeResponse>((_resolve, reject) => {
        const fail = () => reject(scope.signal.reason ?? new Error('aborted'));
        scope.signal.addEventListener('abort', fail, { once: true });
        if (scope.signal.aborted) fail();
      });
    });
    const tree = new RunTreeController();
    const parent = rootScope(runtime, tree);
    const runner = new ChildRunner(runtime, tree);
    const child = runner.run({ parent, agent: jsonAgent('child'), input: 'one' });
    await vi.waitFor(() => expect(scopes).toHaveLength(1));
    const grandchild = runner.run({ parent: scopes[0]!, agent: jsonAgent('grandchild'), input: 'two' });
    await vi.waitFor(() => expect(scopes).toHaveLength(2));

    tree.cancelTree(parent.runId, new Error('stop tree'));
    const settled = await Promise.allSettled([child, grandchild]);

    expect(settled.every(result => result.status === 'rejected')).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(ChildRunError);
    expect(parent.signal.aborted).toBe(true);
    expect(scopes.every(scope => scope.signal.aborted)).toBe(true);
  });

  it('supports fail-fast, collect and guarded retry-safe child failure policies', async () => {
    const attempts = new Map<string, number>();
    const runtime = fakeRuntime(agent => {
      const attempt = (attempts.get(agent.id) ?? 0) + 1;
      attempts.set(agent.id, attempt);
      if (agent.id === 'eventual' && attempt >= 3) return { output: 'recovered' };
      if (agent.id === 'idempotent' && attempt >= 2) return { output: 'written-once' };
      throw new Error(`${agent.id}-failure-${attempt}`);
    });
    const tree = new RunTreeController();
    const runner = new ChildRunner(runtime, tree);
    const parent = rootScope(runtime, tree, {
      budget: new SharedBudgetController({ maxChildRuns: 10 }),
    });

    await expect(runner.run({
      parent,
      agent: jsonAgent('fatal'),
      input: 'x',
      failurePolicy: { mode: 'fail-fast' },
    })).rejects.toMatchObject({ name: 'ChildRunError', attempts: 1 });
    const collected = await runner.run({
      parent,
      agent: jsonAgent('collected'),
      input: 'x',
      failurePolicy: { mode: 'collect' },
    });
    expect(collected).toMatchObject({ status: 'failed', attempts: 1 });

    await expect(runner.run({
      parent,
      agent: jsonAgent('unsafe'),
      input: 'x',
      effect: 'side-effect',
      failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    })).rejects.toThrow('only valid for read or idempotent-write');
    await expect(runner.run({
      parent,
      agent: jsonAgent('missing-key'),
      input: 'x',
      effect: 'idempotent-write',
      failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    })).rejects.toThrow('requires an idempotencyKey');

    const retriedRead = await runner.run({
      parent,
      agent: jsonAgent('eventual'),
      input: 'x',
      effect: 'read',
      failurePolicy: { mode: 'retry-safe', maxAttempts: 3 },
    });
    expect(retriedRead).toMatchObject({
      status: 'completed',
      attempts: 3,
      result: { output: 'recovered' },
    });
    const retriedWrite = await runner.run({
      parent,
      agent: jsonAgent('idempotent'),
      input: 'x',
      effect: 'idempotent-write',
      idempotencyKey: 'write-42',
      failurePolicy: { mode: 'retry-safe', maxAttempts: 2 },
    });
    expect(retriedWrite).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('queries and resumes durable queued or stale-safe children after manager restart', async () => {
    const services = new RuntimeServices();
    const runtime = fakeRuntime(agent => ({ output: `${agent.id}:resumed` }), services);
    const store = new InMemoryDurableChildStore();
    const durableAgent: AgentSpec<JsonValue | undefined, JsonValue> = {
      id: 'background-researcher',
      name: 'Background researcher',
      instructions: 'Research in the background.',
    };
    const tree1 = new RunTreeController();
    const runner1 = new ChildRunner(runtime, tree1);
    const manager1 = new BackgroundChildManager({
      runner: runner1,
      store,
      resolveAgent: id => id === durableAgent.id ? durableAgent : undefined,
      ownerId: 'process-1',
    });
    const parent = rootScope(runtime, tree1);
    const queued = await manager1.spawn({
      parent,
      agent: durableAgent,
      input: 'durable task',
      childId: 'durable-child-1',
      autoStart: false,
    });
    await expect(queued.query()).resolves.toMatchObject({ status: 'queued', revision: 0 });

    const manager2 = new BackgroundChildManager({
      runner: new ChildRunner(runtime, new RunTreeController()),
      store,
      resolveAgent: id => id === durableAgent.id ? durableAgent : undefined,
      ownerId: 'process-2',
    });
    const resumed = manager2.handle('durable-child-1');
    await resumed.resume();
    await expect(resumed.result()).resolves.toMatchObject({
      runId: 'durable-child-1',
      output: 'background-researcher:resumed',
    });
    await expect(resumed.query()).resolves.toMatchObject({
      status: 'completed',
      revision: 2,
      attempts: 1,
    });

    const stale = await manager1.spawn({
      parent,
      agent: durableAgent,
      input: 'recover stale lease',
      childId: 'stale-readable-child',
      effect: 'read',
      autoStart: false,
    });
    const queuedRecord = await stale.query();
    await store.compareAndSet(queuedRecord.childId, queuedRecord.revision, {
      ...queuedRecord,
      revision: queuedRecord.revision + 1,
      status: 'running',
      attempts: 1,
      leaseOwner: 'crashed-process',
      leaseExpiresAt: 0,
    });
    const recovered = manager2.handle('stale-readable-child');
    await recovered.resume();
    await expect(recovered.result()).resolves.toMatchObject({
      runId: 'stale-readable-child',
      output: 'background-researcher:resumed',
    });
  });

  it('validates DAGs deterministically and supports conditional routing plus reducer joins', async () => {
    const runtime = fakeRuntime(() => ({ output: 'unused' }));
    const scope = rootScope(runtime);
    const graph = new WorkflowGraph<string>({
      nodes: [
        { id: 'join', activation: 'any', reduce: ({ inputs }) => [...inputs.values()].join('+') },
        { id: 'route-b', execute: () => 'B' },
        { id: 'router', execute: ({ input }) => input },
        { id: 'route-a', execute: () => 'A' },
      ],
      edges: [
        { from: 'router', to: 'route-a', when: ({ sourceOutput }) => sourceOutput === 'a' },
        { from: 'router', to: 'route-b', when: ({ sourceOutput }) => sourceOutput === 'b' },
        { from: 'route-a', to: 'join' },
        { from: 'route-b', to: 'join' },
      ],
    });

    expect(graph.inspect().order).toEqual(['router', 'route-a', 'route-b', 'join']);
    const result = await graph.execute({ input: 'b', scope, maxConcurrency: 2 });
    expect(Object.fromEntries(result.statuses)).toEqual({
      router: 'completed',
      'route-a': 'skipped',
      'route-b': 'completed',
      join: 'completed',
    });
    expect(result.outputs.get('join')).toBe('B');
    expect([...result.outputs.keys()]).toEqual(['router', 'route-b', 'join']);

    expect(() => new WorkflowGraph({
      nodes: [
        { id: 'a', execute: () => undefined },
        { id: 'b', execute: () => undefined },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    })).toThrow('contains a cycle');
  });

  it('limits concurrent DAG nodes and feeds a deterministic reducer', async () => {
    const runtime = fakeRuntime(() => ({ output: 'unused' }));
    const scope = rootScope(runtime);
    let active = 0;
    let peak = 0;
    const node = (id: string): WorkflowNode<void> => ({
      id,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return id;
      },
    });
    const graph = teamPreset({
      members: [node('c'), node('a'), node('b')],
      reducer: {
        id: 'join',
        reduce: ({ inputs }) => [...inputs.entries()],
      },
    });
    const result = await graph.execute({ input: undefined, scope, maxConcurrency: 2 });

    expect(peak).toBe(2);
    expect(result.outputs.get('join')).toEqual([['a', 'a'], ['b', 'b'], ['c', 'c']]);
    expect(result.order).toEqual(['a', 'b', 'c', 'join']);
  });

  it('expresses panel, reviewer, router, team and swarm as WorkflowGraph presets only', () => {
    const execute = (id: string): WorkflowNode<string> => ({ id, execute: () => id });
    const reduce = (id: string): WorkflowNode<string> => ({
      id,
      reduce: ({ inputs }) => [...inputs.values()],
    });

    expect(panelPreset({ panelists: [execute('p1'), execute('p2')], synthesize: reduce('s') }))
      .toBeInstanceOf(WorkflowGraph);
    expect(teamPreset({ members: [execute('m1')], reducer: reduce('team-join') }))
      .toBeInstanceOf(WorkflowGraph);
    expect(reviewerPreset({
      author: execute('author'),
      reviewers: [execute('reviewer')],
      reducer: reduce('review-join'),
    })).toBeInstanceOf(WorkflowGraph);
    expect(routerPreset({
      router: execute('router'),
      routes: [{ node: execute('route'), when: () => true }],
      reducer: reduce('route-join'),
    })).toBeInstanceOf(WorkflowGraph);
    expect(swarmPreset({
      agents: [execute('a'), execute('b')],
      routes: [{ from: 'a', to: 'b' }],
      reducer: reduce('swarm-join'),
    })).toBeInstanceOf(WorkflowGraph);
  });
});
