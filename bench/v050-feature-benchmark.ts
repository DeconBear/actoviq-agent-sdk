/**
 * v0.5.0 Feature Benchmark Suite
 *
 * Evaluates Dynamic Workflows, Worktrees, and Model Team features
 * through isolated unit-level benchmarks that measure correctness,
 * performance, and edge case handling.
 *
 * Usage: npx tsx bench/v050-feature-benchmark.ts
 */
import { WorkflowScriptRuntime } from '../src/workflow/workflowScriptRuntime.js';
import { WorktreeService } from '../src/worktree/worktreeService.js';
import {
  createModelTeam,
  createTeamTool,
} from '../src/team/modelTeam.js';
import { AgentPool, getGlobalAgentPool, resetGlobalAgentPool } from '../src/team/agentPool.js';
import { getModelPricing, estimateCost } from '../src/team/pricing.js';
import {
  loadWorkflow,
  saveWorkflow,
  listWorkflows,
  deleteWorkflow,
} from '../src/workflow/workflowPersistence.js';
import {
  loadTeamDefinition,
  saveTeamDefinition,
} from '../src/team/teamDefinitions.js';
import type { TeamDefinition, WorkflowMeta } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ═══════════════════════════════════════════════════════════════════
//  Benchmark framework
// ═══════════════════════════════════════════════════════════════════

interface BenchmarkCase {
  name: string;
  feature: string;
  run: () => Promise<BenchmarkResult>;
}

interface BenchmarkResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details?: string;
  error?: string;
  metrics?: Record<string, number>;
}

const results: BenchmarkResult[] = [];

async function bench(name: string, feature: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({
      name,
      passed: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: err.message,
    });
  }
}

function createMockSdk(callLog?: Array<{ prompt: string; opts: any }>) {
  return {
    createSession: async (opts: any) => ({
      id: opts.title ?? 's1',
      send: async (prompt: string, sendOpts: any) => {
        callLog?.push({ prompt, opts: sendOpts ?? {} });
        return {
          text: `{"result": "ok", "analysis": "Test analysis for: ${prompt.slice(0, 30)}"}`,
          message: { content: [{ type: 'text', text: 'response' }] },
          usage: { input_tokens: 100, output_tokens: 50 },
          toolCalls: [],
        };
      },
    }),
    getTool: () => undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Feature 1: Dynamic Workflows benchmarks
// ═══════════════════════════════════════════════════════════════════

async function benchmarkWorkflows(): Promise<void> {
  console.log('\n── Dynamic Workflows Benchmarks ──\n');

  // 1.1: Single agent call
  await bench('WF-01: Single agent() call', 'dynamic-workflows', async () => {
    const callLog: Array<{ prompt: string; opts: any }> = [];
    const sdk = createMockSdk(callLog);
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w1", description: "Single agent call" };',
      'await agent("analyze file structure");',
    ].join('\n');

    const output = await runtime.execute(script);
    if (output.state.agentCalls.length !== 1) throw new Error('Expected 1 agent call');
    if (output.state.agentCalls[0]!.cached) throw new Error('Should not be cached');
    if (output.state.status !== 'completed') throw new Error('Expected completed status');
  });

  // 1.2: Cache hit on repeated call
  await bench('WF-02: Cache hit on identical agent calls', 'dynamic-workflows', async () => {
    const callLog: Array<{ prompt: string; opts: any }> = [];
    const sdk = createMockSdk(callLog);
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w2", description: "Cache test" };',
      'await agent("same prompt");',
      'await agent("same prompt");',
      'await agent("same prompt");',
    ].join('\n');

    const output = await runtime.execute(script);
    // SDK should only be called once (others from cache)
    if (callLog.length !== 1) throw new Error(`Expected 1 SDK call, got ${callLog.length}`);
    const cachedCount = output.state.agentCalls.filter((c) => c.cached).length;
    if (cachedCount !== 2) throw new Error(`Expected 2 cached calls, got ${cachedCount}`);
  });

  // 1.3: Parallel fan-out
  await bench('WF-03: parallel() with 10 thunks', 'dynamic-workflows', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w3", description: "Parallel test" };',
      'const thunks = [];',
      'for (let i = 0; i < 10; i++) {',
      '  thunks.push(async () => "item-" + i);',
      '}',
      'const results = await parallel(thunks);',
      'log("parallel count: " + results.length);',
    ].join('\n');

    const output = await runtime.execute(script);
    if (!output.logs.some((l) => l.includes('parallel count: 10'))) {
      throw new Error('Expected 10 parallel results');
    }
  });

  // 1.4: Pipeline multi-stage
  await bench('WF-04: pipeline() 3 items × 2 stages', 'dynamic-workflows', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w4", description: "Pipeline test" };',
      'const results = await pipeline(',
      '  [10, 20, 30],',
      '  async (prev, item) => item * 2,',
      '  async (prev, item) => prev + 5,',
      ');',
      'log("pipe: " + JSON.stringify(results));',
    ].join('\n');

    const output = await runtime.execute(script);
    if (!output.logs.some((l) => l.includes('pipe:'))) {
      throw new Error('Expected pipeline result log');
    }
  });

  // 1.5: Pipeline error isolation
  await bench('WF-05: Pipeline error isolation (1 item fails)', 'dynamic-workflows', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w5", description: "Error isolation" };',
      'const results = await pipeline(',
      '  [1, 2, 3, 4, 5],',
      '  async (prev, item) => {',
      '    if (item === 3) throw new Error("item 3 broken");',
      '    return item * 100;',
      '  },',
      ');',
      'log("errors: " + results.filter(r => r === null).length);',
    ].join('\n');

    const output = await runtime.execute(script);
    if (output.state.errors.length === 0) throw new Error('Expected at least 1 error');
  });

  // 1.6: Schema enforcement
  await bench('WF-06: StructuredOutput schema validation', 'dynamic-workflows', async () => {
    let callIdx = 0;
    const sdk = {
      createSession: async () => ({
        id: 's1',
        send: async () => {
          callIdx++;
          return {
            text: callIdx === 1
              ? '{"wrong": "format"}'
              : '{"name": "correct", "score": 95}',
            message: { content: [{ type: 'text', text: 'response' }] },
            usage: { input_tokens: 10, output_tokens: 5 },
            toolCalls: [],
          };
        },
      }),
      getTool: () => undefined,
    };

    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, score: { type: 'number' } },
      required: ['name', 'score'],
    };

    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "w6", description: "Schema test" };',
      `const result = await agent("query", { schema: ${JSON.stringify(schema)} });`,
      'log("result: " + JSON.stringify(result));',
    ].join('\n');

    const output = await runtime.execute(script);
    if (output.state.status !== 'completed') throw new Error('Expected completed');
    if (callIdx < 2) throw new Error(`Expected retry, got ${callIdx} calls`);
  });

  // 1.7: Phase tracking
  await bench('WF-07: Phase progress tracking', 'dynamic-workflows', async () => {
    const sdk = createMockSdk();
    let phaseEvents: string[] = [];
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      onEvent: (e: any) => {
        if (e.type === 'workflow.phase.start') phaseEvents.push(e.phase);
      },
    });

    const script = [
      'export const meta = { name: "w7", description: "Phase test",',
      '  phases: [{ title: "Init" }, { title: "Process" }, { title: "Cleanup" }] };',
      'phase("Init"); await agent("init");',
      'phase("Process"); await agent("process");',
      'phase("Cleanup"); await agent("cleanup");',
    ].join('\n');

    const output = await runtime.execute(script);
    if (phaseEvents.length < 3) throw new Error(`Expected 3 phase events, got ${phaseEvents.length}`);
  });

  // 1.8: Budget tracking
  await bench('WF-08: Budget tracking and enforcement', 'dynamic-workflows', async () => {
    const sdk = createMockSdk();
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      budgetTotal: 200, // Only 200 tokens allowed
    });

    const script = [
      'export const meta = { name: "w8", description: "Budget test" };',
      'log("remaining before: " + budget.remaining());',
      'try { await agent("query"); } catch(e) { log("agent error: " + e.message); }',
      'log("remaining after: " + budget.remaining());',
    ].join('\n');

    const output = await runtime.execute(script);
    const remainingBefore = output.logs.find((l) => l.startsWith('remaining before:'));
    if (!remainingBefore || remainingBefore.includes('Infinity')) {
      throw new Error('Budget should have a finite remaining value');
    }
  });

  // 1.9: Workflow persistence save/load
  await bench('WF-09: Workflow script save and load', 'dynamic-workflows', async () => {
    const tmpDir = path.join(os.tmpdir(), `actoviq-bench-wf-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.actoviq', 'workflows'), { recursive: true });

    try {
      const script = [
        'export const meta = { name: "bench-wf", description: "Benchmark workflow" };',
        'await agent("benchmark task");',
      ].join('\n');

      const filePath = await saveWorkflow('bench-wf', script, { projectDir: tmpDir });
      if (!fs.existsSync(filePath)) throw new Error('Saved file not found');

      const loaded = loadWorkflow('bench-wf', tmpDir);
      if (!loaded) throw new Error('Failed to load workflow');
      if (loaded.meta?.name !== 'bench-wf') throw new Error('Wrong meta name');

      await deleteWorkflow('bench-wf', tmpDir);
      if (loadWorkflow('bench-wf', tmpDir)) throw new Error('Workflow not deleted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Feature 2: Worktrees benchmarks
// ═══════════════════════════════════════════════════════════════════

async function benchmarkWorktrees(): Promise<void> {
  console.log('\n── Worktree Benchmarks ──\n');

  // 2.1: Service creation
  await bench('WT-01: WorktreeService creation', 'worktrees', async () => {
    const service = new WorktreeService(process.cwd());
    if (service.isInWorktree) throw new Error('Should not be in worktree initially');
    if (!service.currentWorkDir) throw new Error('Should have a current workDir');
  });

  // 2.2: Name generation
  await bench('WT-02: Auto-generated worktree names', 'worktrees', async () => {
    const { generateWorktreeName } = await import('../src/worktree/worktreeService.js');
    const names = new Set(Array.from({ length: 100 }, () => generateWorktreeName()));
    if (names.size < 50) throw new Error(`Low uniqueness: ${names.size}/100`);
    for (const name of names) {
      if (name.split('-').length !== 3) throw new Error(`Invalid name format: ${name}`);
    }
  });

  // 2.3: Stack operations
  await bench('WT-03: Worktree stack push/pop', 'worktrees', async () => {
    const service = new WorktreeService(process.cwd());
    if (service.isInWorktree) throw new Error('Should start outside worktree');

    // Can't actually enter a worktree without git, but we can test the stack API
    try {
      service.exitWorktree();
      throw new Error('Should throw on exit from main');
    } catch (e: any) {
      if (!e.message.includes('Not in a worktree')) throw e;
    }
  });

  // 2.4: .worktreeinclude parsing
  await bench('WT-04: .worktreeinclude pattern matching', 'worktrees', async () => {
    const { parseWorktreeInclude } = await import('../src/worktree/worktreeInclude.js');
    const { matchesPattern } = await import('../src/worktree/worktreeInclude.js');

    const tmpFile = path.join(os.tmpdir(), `actoviq-bench-wi-${Date.now()}`);
    const content = [
      '.env',
      '.env.*',
      'config/*.json',
      '**/secrets.*',
    ].join('\n');
    fs.writeFileSync(tmpFile, content);

    try {
      const patterns = await parseWorktreeInclude(tmpFile);
      if (patterns.length !== 4) throw new Error(`Expected 4 patterns, got ${patterns.length}`);

      // Test matching
      if (!matchesPattern('.env', '.env')) throw new Error('.env should match');
      if (!matchesPattern('.env.local', '.env.*')) throw new Error('.env.local should match');
      if (!matchesPattern('config/db.json', 'config/*.json')) throw new Error('config/db.json should match');
      if (!matchesPattern('deep/nested/secrets.key', '**/secrets.*')) throw new Error('deep/nested should match');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  // 2.5: EnterWorktree tool definition
  await bench('WT-05: EnterWorktree tool schema', 'worktrees', async () => {
    const { createEnterWorktreeTool } = await import('../src/tools/enterWorktree.js');
    const tool = createEnterWorktreeTool(() => undefined);

    if (tool.name !== 'EnterWorktree') throw new Error('Wrong tool name');
    if (tool.kind !== 'local') throw new Error('Wrong tool kind');
    const props = tool.inputJsonSchema.properties as Record<string, unknown> | undefined;
    if (!props?.name) throw new Error('Missing name param');
    if (!props?.path) throw new Error('Missing path param');
    if (!props?.pr) throw new Error('Missing pr param');
  });

  // 2.6: ExitWorktree tool
  await bench('WT-06: ExitWorktree tool behavior', 'worktrees', async () => {
    const { createExitWorktreeTool } = await import('../src/tools/exitWorktree.js');
    const service = new WorktreeService(process.cwd());
    const tool = createExitWorktreeTool(() => service);

    const result = await tool.execute({}, {} as any);
    if (!result.includes('Not currently in a worktree')) {
      throw new Error('Should indicate not in worktree');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Feature 3: Model Team benchmarks
// ═══════════════════════════════════════════════════════════════════

async function benchmarkModelTeam(): Promise<void> {
  console.log('\n── Model Team Benchmarks ──\n');

  // 3.1: Team validation (all modes)
  await bench('MT-01: Model validation — panel mode', 'model-team', async () => {
    const def: TeamDefinition = {
      name: 'bench-panel',
      mode: 'panel',
      members: [
        { model: 'claude-sonnet-4-6' },
        { model: 'deepseek-v4-pro' },
      ],
      primary: { model: 'claude-opus-4-8' },
    };
    const team = createModelTeam(def);
    if (team.name !== 'bench-panel') throw new Error('Wrong name');
    if (team.definition.mode !== 'panel') throw new Error('Wrong mode');
  });

  // 3.2: Router mode validation
  await bench('MT-02: Model validation — router mode', 'model-team', async () => {
    const def: TeamDefinition = {
      name: 'bench-router',
      mode: 'router',
      members: [],
      router: { model: 'claude-haiku-4-5' },
      specialists: {
        coding: { model: 'claude-sonnet-4-6', description: 'Code tasks' },
        writing: { model: 'gpt-4o', description: 'Writing tasks' },
      },
    };
    const team = createModelTeam(def);
    if (team.definition.mode !== 'router') throw new Error('Wrong mode');
    if (!team.definition.specialists?.coding) throw new Error('Missing specialist');
  });

  // 3.3: Discussion mode validation
  await bench('MT-03: Model validation — discussion mode', 'model-team', async () => {
    const def: TeamDefinition = {
      name: 'bench-discussion',
      mode: 'discussion',
      members: [
        { model: 'claude-sonnet-4-6', systemPrompt: 'Architecture expert' },
        { model: 'deepseek-v4-pro', systemPrompt: 'Performance expert' },
        { model: 'gemini-3-flash', systemPrompt: 'Security expert' },
      ],
      primary: { model: 'claude-opus-4-8' },
      facilitator: { model: 'claude-sonnet-4-6' },
    };
    const team = createModelTeam(def);
    if (team.definition.members.length !== 3) throw new Error('Wrong member count');
  });

  // 3.4: Executor-Reviewer mode validation
  await bench('MT-04: Model validation — executor-reviewer mode', 'model-team', async () => {
    const def: TeamDefinition = {
      name: 'bench-er',
      mode: 'executor-reviewer',
      members: [],
      executor: { model: 'claude-sonnet-4-6' },
      reviewer: { model: 'claude-opus-4-8' },
    };
    const team = createModelTeam(def);
    if (team.definition.mode !== 'executor-reviewer') throw new Error('Wrong mode');
  });

  // 3.5: Invalid team — missing primary
  await bench('MT-05: Validation rejects invalid teams', 'model-team', async () => {
    try {
      createModelTeam({
        name: 'bad',
        mode: 'panel',
        members: [{ model: 'test' }],
      });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('primary')) throw new Error('Wrong error message');
    }
  });

  // 3.6: Pricing data integrity
  await bench('MT-06: Pricing data for all known models', 'model-team', async () => {
    const models = [
      'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5',
      'gpt-5.5', 'gpt-4o', 'gpt-4o-mini',
      'deepseek-v4-pro', 'deepseek-v3',
      'gemini-3-flash', 'gemini-2.5-pro',
      'kimi-k2.6',
    ];
    for (const model of models) {
      const pricing = getModelPricing(model);
      if (!pricing) throw new Error(`Missing pricing for ${model}`);
      if (pricing.input <= 0 || pricing.output <= 0) {
        throw new Error(`Invalid pricing for ${model}: ${JSON.stringify(pricing)}`);
      }
    }
  });

  // 3.7: Cost estimation accuracy
  await bench('MT-07: Cost estimation calculation', 'model-team', async () => {
    // sonnet: $3/M input, $15/M output
    const cost = estimateCost('claude-sonnet-4-6', 500_000, 200_000);
    // 500k/1M * $3 = $1.5 input + 200k/1M * $15 = $3 output = $4.5
    if (cost === null) throw new Error('Should have pricing');
    if (Math.abs(cost - 4.5) > 0.1) throw new Error(`Expected ~$4.5, got $${cost}`);
  });

  // 3.8: AgentPool concurrency
  await bench('MT-08: AgentPool concurrency control', 'model-team', async () => {
    resetGlobalAgentPool(2);
    const pool = getGlobalAgentPool();

    const s1 = await pool.acquire();
    const s2 = await pool.acquire();
    if (pool.activeCount !== 2) throw new Error('Expected 2 active');

    // 3rd should queue
    const p3 = pool.acquire(1000);
    await new Promise((r) => setTimeout(r, 10));
    if (pool.queuedCount !== 1) throw new Error('Expected 1 queued');

    s1.release();
    const s3 = await p3;
    if (pool.activeCount !== 2) throw new Error('Expected 2 active after release');

    s2.release();
    s3.release();
    pool.reset();
  });

  // 3.9: createTeamTool
  await bench('MT-09: Team as agent tool', 'model-team', async () => {
    const def: TeamDefinition = {
      name: 'bench-team-tool',
      description: 'Benchmark team tool',
      mode: 'panel',
      members: [{ model: 'claude-sonnet-4-6' }],
      primary: { model: 'claude-opus-4-8' },
    };
    const tool = createTeamTool(def);
    if (tool.name !== 'bench-team-tool') throw new Error('Wrong tool name');
    if (tool.interruptBehavior !== 'block') throw new Error('Expected block interrupt');
    if (tool.kind !== 'local') throw new Error('Expected local tool');
  });

  // 3.10: Team definitions from disk
  await bench('MT-10: Team definition save/load round-trip', 'model-team', async () => {
    const tmpDir = path.join(os.tmpdir(), `actoviq-bench-mt-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.actoviq', 'teams'), { recursive: true });

    try {
      const def: TeamDefinition = {
        name: 'bench-team-disk',
        mode: 'panel',
        members: [
          { model: 'claude-sonnet-4-6' },
          { model: 'gpt-4o', provider: 'openai', apiKey: '$OPENAI_KEY' },
        ],
        primary: { model: 'claude-opus-4-8' },
      };

      const filePath = await saveTeamDefinition(def, { projectDir: tmpDir });
      if (!fs.existsSync(filePath)) throw new Error('File not saved');

      const loaded = loadTeamDefinition('bench-team-disk', tmpDir);
      if (!loaded) throw new Error('Failed to load');
      if (loaded.definition.members.length !== 2) throw new Error('Wrong member count');

      await deleteTeamDefinition('bench-team-disk', tmpDir);
      if (loadTeamDefinition('bench-team-disk', tmpDir)) throw new Error('Not deleted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   v0.5.0 Feature Benchmark Suite             ║');
  console.log('╚══════════════════════════════════════════════╝');

  const overallStart = Date.now();

  await benchmarkWorkflows();
  await benchmarkWorktrees();
  await benchmarkModelTeam();

  const totalDuration = Date.now() - overallStart;

  // ── Report ──────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Benchmark Results                          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // By feature
  const features = ['dynamic-workflows', 'worktrees', 'model-team'];
  for (const feature of features) {
    const featureResults = results.filter((r) => r.passed && results.some((x) => x.name.startsWith(feature === 'dynamic-workflows' ? 'WF' : feature === 'worktrees' ? 'WT' : 'MT')));
    const featurePassed = results.filter((r) => r.passed && (feature === 'dynamic-workflows' ? r.name.startsWith('WF') : feature === 'worktrees' ? r.name.startsWith('WT') : r.name.startsWith('MT')));
    const featureFailed = results.filter((r) => !r.passed && (feature === 'dynamic-workflows' ? r.name.startsWith('WF') : feature === 'worktrees' ? r.name.startsWith('WT') : r.name.startsWith('MT')));

    console.log(`${feature}:`);
    console.log(`  Passed: ${featurePassed.length}/${featurePassed.length + featureFailed.length}`);
    const avgDuration = featurePassed.reduce((sum, r) => sum + r.durationMs, 0) / Math.max(1, featurePassed.length);
    console.log(`  Avg duration: ${Math.round(avgDuration)}ms`);
    console.log();
  }

  console.log(`Total: ${passed.length}/${results.length} passed`);
  console.log(`Total duration: ${totalDuration}ms`);

  if (failed.length > 0) {
    console.log(`\n❌ ${failed.length} FAILED:`);
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All benchmarks passed!');
  }
}

// Import needed for delete
import { deleteTeamDefinition } from '../src/team/teamDefinitions.js';

main().catch((err) => {
  console.error('Benchmark suite failed:', err);
  process.exit(1);
});
