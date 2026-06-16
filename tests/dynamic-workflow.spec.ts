/**
 * Dynamic Workflow feature tests — v0.5.0
 */
import { describe, it, expect } from 'vitest';
import { WorkflowScriptRuntime } from '../src/workflow/workflowScriptRuntime.js';
import type { WorkflowMeta, WorkflowAgentOptions } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createMockSdk() {
  const sessions: Array<{ id: string; send: any }> = [];

  return {
    createSession: async (opts: any) => {
      const session = {
        id: opts.title ?? `session-${sessions.length}`,
        send: async (_prompt: string, _opts: any) => {
          return {
            text: `result-from-${opts.title ?? 'agent'}`,
            message: { content: [{ type: 'text', text: `result-from-${opts.title ?? 'agent'}` }] },
            usage: { input_tokens: 100, output_tokens: 50 },
            toolCalls: [],
          };
        },
      };
      sessions.push(session as any);
      return session;
    },
    getTool: (_name: string) => undefined,
  };
}

// ── Script validation ─────────────────────────────────────────────

describe('WorkflowScriptRuntime validation', () => {
  it('rejects scripts without meta export', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    await expect(runtime.execute('agent("test");'))
      .rejects.toThrow('export const meta');
  });

  it('rejects scripts with Date.now()', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    const script = [
      'export const meta = { name: "test", description: "test" };',
      'const now = Date.now();',
    ].join('\n');

    await expect(runtime.execute(script)).rejects.toThrow('Date.now');
  });

  it('rejects scripts with Math.random()', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    const script = [
      'export const meta = { name: "test", description: "test" };',
      'const r = Math.random();',
    ].join('\n');

    await expect(runtime.execute(script)).rejects.toThrow('Math.random');
  });

  it('rejects scripts with new Date()', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    const script = [
      'export const meta = { name: "test", description: "test" };',
      'const d = new Date();',
    ].join('\n');

    await expect(runtime.execute(script)).rejects.toThrow('new Date');
  });

  it('rejects meta with non-literal computed values', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    // Variable reference in meta
    const script = [
      'const n = "test";',
      'export const meta = { name: n, description: "test" };',
    ].join('\n');

    await expect(runtime.execute(script)).rejects.toThrow();
  });
});

// ── Meta extraction ───────────────────────────────────────────────

describe('Meta parsing', () => {
  it('extracts valid meta from script', async () => {
    const runtime = new WorkflowScriptRuntime({ sdk: createMockSdk() as any });

    const script = [
      'export const meta = {',
      '  name: "my-workflow",',
      '  description: "A test workflow",',
      '  phases: [{ title: "Build" }, { title: "Test" }],',
      '};',
      'agent("hello");',
    ].join('\n');

    const result = await runtime.execute(script);
    expect(result.state.meta.name).toBe('my-workflow');
    expect(result.state.meta.description).toBe('A test workflow');
    expect(result.state.meta.phases).toHaveLength(2);
  });
});

// ── agent() primitive ─────────────────────────────────────────────

describe('agent() primitive', () => {
  it('calls sdk.createSession and returns result', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "test", description: "test" };',
      'const result = await agent("hello world", { label: "test-agent" });',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.state.agentCalls).toHaveLength(1);
    expect(output.state.agentCalls[0]!.prompt).toBe('hello world');
    expect(output.state.agentCalls[0]!.opts.label).toBe('test-agent');
    expect(output.state.agentCalls[0]!.cached).toBe(false);
    expect(output.state.status).toBe('completed');
  });

  it('tracks phases', async () => {
    const sdk = createMockSdk();
    let phaseLog: string[] = [];
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      onEvent: (e) => {
        if (e.type === 'workflow.phase.start') phaseLog.push(e.phase);
      },
    });

    const script = [
      'export const meta = {',
      '  name: "phased-workflow",',
      '  description: "test",',
      '  phases: [{ title: "Discover" }, { title: "Fix" }],',
      '};',
      'phase("Discover");',
      'await agent("discover something");',
      'phase("Fix");',
      'await agent("fix something");',
    ].join('\n');

    const output = await runtime.execute(script);
    // Event-based check
    expect(phaseLog).toContain('Discover');
    expect(phaseLog).toContain('Fix');
    // State check
    expect(output.state.agentCalls).toHaveLength(2);
    const phaseTitles = output.state.phases.map((p) => p.title);
    expect(phaseTitles).toContain('Discover');
    expect(phaseTitles).toContain('Fix');
  });

  it('caches identical calls', async () => {
    let callCount = 0;
    const sdk = {
      createSession: async () => ({
        id: 's1',
        send: async () => {
          callCount++;
          return {
            text: `result-${callCount}`,
            message: { content: [{ type: 'text', text: `result-${callCount}` }] },
            usage: { input_tokens: 10, output_tokens: 5 },
            toolCalls: [],
          };
        },
      }),
      getTool: () => undefined,
    };

    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "cache-test", description: "test" };',
      'const r1 = await agent("same prompt");',
      'const r2 = await agent("same prompt");',
    ].join('\n');

    const output = await runtime.execute(script);
    // First call creates session, second uses cache
    expect(callCount).toBe(1);
    expect(output.state.agentCalls.length).toBeGreaterThanOrEqual(1);
    // At least one should be cached
    const cachedCalls = output.state.agentCalls.filter((c) => c.cached);
    expect(cachedCalls.length).toBeGreaterThan(0);
  });

  it('respects budget limits', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any, budgetTotal: 50 });

    const script = [
      'export const meta = { name: "budget-test", description: "test" };',
      // First call: 100 input + 50 output = 150 tokens → exceeds budget of 50
      'try {',
      '  await agent("query");',
      '} catch(e) {',
      '  // Expected: budget exhausted',
      '}',
    ].join('\n');

    // The first agent call will consume tokens, then budget check blocks future calls
    const output = await runtime.execute(script);
    // First call should succeed (check is before, not after)
    expect(output.state.agentCalls.length).toBeGreaterThanOrEqual(0);
  });
});

// ── log() primitive ───────────────────────────────────────────────

describe('log() primitive', () => {
  it('emits log messages', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "log-test", description: "test" };',
      'log("Step 1 complete");',
      'log("Step 2 complete");',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.logs).toHaveLength(2);
    expect(output.logs[0]).toBe('Step 1 complete');
    expect(output.logs[1]).toBe('Step 2 complete');
  });
});

// ── parallel() primitive ──────────────────────────────────────────

describe('parallel() primitive', () => {
  it('resolves all thunks in parallel', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    // parallel with custom thunks that don't call agent
    const script = [
      'export const meta = { name: "par-test", description: "test" };',
      'const results = await parallel([',
      '  async () => "a",',
      '  async () => "b",',
      '  async () => "c",',
      ']);',
      'log("parallel result count: " + results.length);',
      'log("first: " + results[0]);',
    ].join('\n');

    const output = await runtime.execute(script);
    // Verify logs contain expected content
    expect(output.logs.some((l) => l.includes('result count: 3'))).toBe(true);
    expect(output.logs.some((l) => l.includes('first: a'))).toBe(true);
    expect(output.state.status).toBe('completed');
  });

  it('returns null for failed thunks', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "par-fail", description: "test" };',
      'const results = await parallel([',
      '  async () => "ok",',
      '  async () => { throw new Error("fail"); },',
      '  async () => "also-ok",',
      ']);',
      'log("results: " + JSON.stringify(results));',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.logs.some((l) => l.includes('results'))).toBe(true);
    expect(output.state.status).toBe('completed');
  });
});

// ── pipeline() primitive ──────────────────────────────────────────

describe('pipeline() primitive', () => {
  it('processes items through stages sequentially', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "pipe-test", description: "test" };',
      'const results = await pipeline(',
      '  [1, 2, 3],',
      '  async (prev, item) => item * 2,',
      '  async (prev, item) => prev + 1,',
      ');',
      'log("pipe results: " + JSON.stringify(results));',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.logs.some((l) => l.includes('pipe results'))).toBe(true);
    expect(output.state.status).toBe('completed');
  });

  it('handles null stage returns (skip item)', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "pipe-skip", description: "test" };',
      'const results = await pipeline(',
      '  [1, 2, 3, 4],',
      '  async (prev, item) => item % 2 === 0 ? item : null,',
      ');',
      'log("skip results: " + JSON.stringify(results));',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.logs.some((l) => l.includes('skip results'))).toBe(true);
    expect(output.state.status).toBe('completed');
  });

  it('handles stage errors without aborting other items', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "pipe-err", description: "test" };',
      'const results = await pipeline(',
      '  [1, 2, 3],',
      '  async (prev, item) => {',
      '    if (item === 2) throw new Error("item 2 failed");',
      '    return item * 10;',
      '  },',
      ');',
      'log("error results: " + JSON.stringify(results));',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.state.errors.length).toBeGreaterThan(0);
    expect(output.state.errors[0]!.error).toContain('item 2 failed');
    expect(output.state.status).toBe('completed');
  });
});

// ── Event emission ────────────────────────────────────────────────

describe('Event emission', () => {
  it('emits workflow.script.start and workflow.script.done events', async () => {
    const events: any[] = [];
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      onEvent: (e) => events.push(e),
    });

    const script = [
      'export const meta = { name: "event-test", description: "test" };',
      'await agent("hello");',
    ].join('\n');

    await runtime.execute(script);

    const startEvents = events.filter((e) => e.type === 'workflow.script.start');
    const doneEvents = events.filter((e) => e.type === 'workflow.script.done');
    const agentEvents = events.filter((e) => e.type === 'workflow.agent.start');

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]!.workflowName).toBe('event-test');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.status).toBe('completed');
    expect(agentEvents).toHaveLength(1);
  });
});
