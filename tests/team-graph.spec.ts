/**
 * Team graph orchestration tests — TeamDefinition version 2.
 *
 * Covers the three pure layers of src/team/teamGraph.ts:
 *  - validateTeamGraph: DAG/entry/ref/cap rules
 *  - migrateTeamDefinitionToV2: legacy modes → graph nodes/edges (reviewEdges dropped)
 *  - orchestrateGraph: wait-all joins, fail-soft propagation, edge events,
 *    skipped nodes, payload templates (injected runners — no model calls)
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_GRAPH_NODES,
  graphNodeRef,
  validateTeamGraph,
  validateTeamGraphV2,
  assertValidTeamGraph,
  migrateTeamDefinitionToV2,
  migrateTeamDefinitionToGraph,
  orchestrateGraph,
  edgeConditionPasses,
  createNotifyTeammateTool,
  type GraphNodeRunContext,
} from '../src/team/teamGraph.js';
import type { TeamDefinition, TeamEvent, TeamGraphNode } from '../src/types.js';

function graphDef(partial: Partial<TeamDefinition>): TeamDefinition {
  return {
    name: 'graph-test',
    mode: 'graph',
    version: 2,
    orchestration: 'graph',
    members: [],
    ...partial,
  };
}

const node = (id: string, extra: Partial<TeamGraphNode> = {}): TeamGraphNode => ({
  id,
  model: 'test-model',
  ...extra,
});

describe('validateTeamGraphV2', () => {
  it('accepts a minimal valid pipeline', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b')],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(validateTeamGraphV2(def)).toEqual([]);
  });

  it('requires at least one node', () => {
    const errors = validateTeamGraphV2(graphDef({ nodes: [] }));
    expect(errors).toEqual(['graph mode requires at least one node']);
  });

  it('enforces the node cap without truncating', () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => node(`n${i}`, { entry: true }));
    const errors = validateTeamGraphV2(graphDef({ nodes }));
    expect(errors.some((e) => e.includes(`at most ${MAX_GRAPH_NODES}`))).toBe(true);
  });

  it('rejects duplicate node refs instead of silently disambiguating', () => {
    const def = graphDef({ nodes: [node('same', { entry: true }), node('same')] });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('duplicate node ref "same"'))).toBe(true);
  });

  it('rejects a node with no addressable ref', () => {
    const def = graphDef({ nodes: [{ model: '' } as TeamGraphNode] });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('no id/name/role/model'))).toBe(true);
  });

  it('requires an entry node', () => {
    const def = graphDef({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('at least one entry node'))).toBe(true);
  });

  it('accepts entryNodeIds as an alternative to entry: true', () => {
    const def = graphDef({
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'b' }],
      entryNodeIds: ['a'],
    });
    expect(validateTeamGraphV2(def)).toEqual([]);
  });

  it('flags unknown entryNodeIds and edge endpoints', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true })],
      edges: [{ from: 'a', to: 'ghost' }],
      entryNodeIds: ['missing'],
    });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('entryNodeIds references unknown node "missing"'))).toBe(true);
    expect(errors.some((e) => e.includes('unknown "to" node "ghost"'))).toBe(true);
  });

  it('rejects self-loops', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true })],
      edges: [{ from: 'a', to: 'a' }],
    });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('self-loop'))).toBe(true);
  });

  it('rejects cycles even across non-auto triggers', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a', trigger: 'manual' },
      ],
    });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
    expect(() => assertValidTeamGraph(def)).toThrow();
  });

  it('rejects an invalid regex condition on an edge', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b')],
      edges: [{ from: 'a', to: 'b', condition: '/[unclosed/' }],
    });
    const errors = validateTeamGraphV2(def);
    expect(errors.some((e) => e.includes('invalid regex condition'))).toBe(true);
  });

  it('resolves node refs by name/role/model fallbacks', () => {
    const def = graphDef({
      nodes: [
        { name: 'planner', model: 'm1', entry: true },
        { role: 'coder', model: 'm2' },
      ],
      edges: [{ from: 'planner', to: 'coder' }],
    });
    expect(validateTeamGraphV2(def)).toEqual([]);
    expect(graphNodeRef({ name: 'planner', model: 'm1' })).toBe('planner');
    expect(graphNodeRef({ role: 'coder', model: 'm2' })).toBe('coder');
    expect(graphNodeRef({ model: 'm2' })).toBe('m2');
  });
});

describe('validateTeamGraph (v3 canonical)', () => {
  it('accepts a v2 pipeline after migration to Task/Return ports', () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b')],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(validateTeamGraph(def)).toEqual([]);
    expect(() => assertValidTeamGraph(def)).not.toThrow();
  });
});

describe('migrateTeamDefinitionToV2', () => {
  it('maps panel members + primary to entry nodes feeding a synthesizer', () => {
    const def: TeamDefinition = {
      name: 'panel',
      mode: 'panel-analysis',
      members: [
        { id: 'researcher', model: 'm1' },
        { id: 'skeptic', model: 'm2' },
      ],
      primary: { id: 'synth', model: 'm3' },
    };
    const migrated = migrateTeamDefinitionToV2(def);

    expect(migrated.mode).toBe('graph');
    expect(migrated.version).toBe(2);
    expect(migrated.orchestration).toBe('graph');
    expect(migrated.nodes?.map((n) => ({ id: n.id, entry: n.entry ?? false }))).toEqual([
      { id: 'researcher', entry: true },
      { id: 'skeptic', entry: true },
      { id: 'synth', entry: false },
    ]);
    expect(migrated.edges).toEqual([
      { from: 'researcher', to: 'synth', channel: 'message', trigger: 'on_complete' },
      { from: 'skeptic', to: 'synth', channel: 'message', trigger: 'on_complete' },
    ]);
    expect(validateTeamGraph(migrated)).toEqual([]);
  });

  it('maps reviewer mode to a single agent with payload Return', () => {
    const def: TeamDefinition = {
      name: 'rev',
      mode: 'reviewer',
      members: [],
      reviewer: { id: 'reviewer', model: 'm1' },
    };
    const migrated = migrateTeamDefinitionToGraph(def);
    expect(migrated.nodes?.some((n) => n.kind === 'task')).toBe(true);
    expect(migrated.nodes?.some((n) => n.kind === 'return' && n.returnMode === 'payload')).toBe(true);
    expect(validateTeamGraph(migrated)).toEqual([]);
  });

  it('converts reviewEdges into review-channel edges and drops the field', () => {
    const def: TeamDefinition = {
      name: 'collab',
      mode: 'analysis',
      members: [
        { id: 'planner', model: 'm1' },
        { id: 'coder', model: 'm2' },
      ],
      reviewEdges: [{ from: 'planner', to: 'coder', kind: 'review', note: 'plan gate' }],
    };
    const migrated = migrateTeamDefinitionToV2(def);
    expect(migrated.reviewEdges).toBeUndefined();
    expect(migrated.edges).toContainEqual({
      from: 'planner',
      to: 'coder',
      channel: 'review',
      trigger: 'on_complete',
      note: 'plan gate',
    });
  });

  it('returns graph definitions as-is and never mutates the input', () => {
    const alreadyGraph = graphDef({ nodes: [node('a', { entry: true })] });
    expect(migrateTeamDefinitionToV2(alreadyGraph)).toBe(alreadyGraph);

    const legacy: TeamDefinition = {
      name: 'legacy',
      mode: 'panel',
      members: [{ id: 'a', model: 'm1' }],
      primary: { id: 'p', model: 'm2' },
      reviewEdges: [{ from: 'a', to: 'p' }],
    };
    const snapshot = JSON.parse(JSON.stringify(legacy));
    migrateTeamDefinitionToV2(legacy);
    expect(legacy).toEqual(snapshot);
  });
});

describe('orchestrateGraph', () => {
  it('runs a linear pipeline, passing upstream output downstream', async () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b')],
      edges: [{ from: 'a', to: 'b' }],
    });
    const tasks: Record<string, string> = {};
    const result = await orchestrateGraph({
      prompt: 'TASK',
      definition: def,
      runNode: async (_node, identity, task) => {
        tasks[identity.id] = task;
        return { report: `report-${identity.id}`, ok: true };
      },
    });

    expect(tasks.a).toBe('TASK');
    expect(tasks.b).toContain('TASK');
    expect(tasks.b).toContain('## Input from a');
    expect(tasks.b).toContain('report-a');
    // Only the terminal node's report is the answer.
    expect(result.answer).toBe('report-b');
    expect(result.skipped).toEqual([]);
    expect(result.reports.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('wait-all: a join node wakes exactly once, after every upstream', async () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b', { entry: true }), node('join')],
      edges: [
        { from: 'a', to: 'join' },
        { from: 'b', to: 'join' },
      ],
    });
    const runs: string[] = [];
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity, task) => {
        runs.push(identity.id);
        if (identity.id === 'join') {
          expect(task).toContain('## Input from a');
          expect(task).toContain('## Input from b');
        }
        return { report: `out-${identity.id}`, ok: true };
      },
    });

    expect(runs.filter((id) => id === 'join')).toHaveLength(1);
    expect(runs.indexOf('join')).toBe(2);
    expect(result.answer).toBe('out-join');
  });

  it('fail-soft: a failed upstream delivers a [FAILED …] marker, run continues', async () => {
    const def = graphDef({
      nodes: [node('bad', { entry: true }), node('down')],
      edges: [{ from: 'bad', to: 'down' }],
    });
    let downTask = '';
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity, task) => {
        if (identity.id === 'bad') return { report: '', ok: false, error: 'boom' };
        downTask = task;
        return { report: 'recovered', ok: true };
      },
    });

    expect(downTask).toContain('[FAILED: bad — boom]');
    expect(result.answer).toBe('recovered');
    expect(result.reports.find((r) => r.id === 'bad')!.ok).toBe(false);
  });

  it('emits team.edge.triggered for every fired on_complete edge', async () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b', { entry: true }), node('sink')],
      edges: [
        { from: 'a', to: 'sink', channel: 'review' },
        { from: 'b', to: 'sink' },
      ],
    });
    const events: TeamEvent[] = [];
    await orchestrateGraph({
      prompt: 'P',
      definition: def,
      onEvent: (e) => events.push(e),
      runNode: async (_node, identity) => ({ report: identity.id, ok: true }),
    });

    const edges = events.filter((e) => e.type === 'team.edge.triggered');
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({
      type: 'team.edge.triggered', from: 'a', to: 'sink', trigger: 'on_complete', channel: 'review',
    });
    expect(edges).toContainEqual({
      type: 'team.edge.triggered', from: 'b', to: 'sink', trigger: 'on_complete', channel: 'message',
    });
  });

  it('reports nodes with only manual in-edges as skipped', async () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('debug-only')],
      edges: [{ from: 'a', to: 'debug-only', trigger: 'manual' }],
    });
    const ran: string[] = [];
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => {
        ran.push(identity.id);
        return { report: identity.id, ok: true };
      },
    });

    expect(ran).toEqual(['a']);
    expect(result.skipped).toEqual(['debug-only']);
    // `a` has no AUTO out-edge, so it is the terminal answer.
    expect(result.answer).toBe('a');
  });

  it('concatenates multiple terminal reports with identity headers', async () => {
    const def = graphDef({
      nodes: [node('x', { entry: true }), node('y', { entry: true })],
    });
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => ({ report: `R:${identity.id}`, ok: true }),
    });
    expect(result.answer).toContain('### x\nR:x');
    expect(result.answer).toContain('### y\nR:y');
    expect(result.answer).toContain('---');
  });

  it('renders payloadTemplate placeholders', async () => {
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b')],
      edges: [{
        from: 'a',
        to: 'b',
        payloadTemplate: 'From={{from.id}} Out={{from.output}} Prompt={{run.prompt}}',
      }],
    });
    let received = '';
    await orchestrateGraph({
      prompt: 'THE-PROMPT',
      definition: def,
      runNode: async (_node, identity, task) => {
        if (identity.id === 'b') received = task;
        return { report: `out-${identity.id}`, ok: true };
      },
    });
    expect(received).toContain('From=a Out=out-a Prompt=THE-PROMPT');
  });

  it('condition gates: substring and regex forms', () => {
    expect(edgeConditionPasses(undefined, 'anything')).toBe(true);
    expect(edgeConditionPasses('APPROVED', 'status: APPROVED')).toBe(true);
    expect(edgeConditionPasses('APPROVED', 'status: rejected')).toBe(false);
    expect(edgeConditionPasses('/approved/i', 'Status: APPROVED')).toBe(true);
    expect(edgeConditionPasses('/^ok$/', 'ok')).toBe(true);
    expect(edgeConditionPasses('/^ok$/', 'not ok')).toBe(false);
  });

  it('a gated-out edge releases without waking; other branch still runs', async () => {
    // a → approve (condition APPROVED), a → reject (condition REJECTED)
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('approve'), node('reject')],
      edges: [
        { from: 'a', to: 'approve', condition: 'APPROVED' },
        { from: 'a', to: 'reject', condition: 'REJECTED' },
      ],
    });
    const ran: string[] = [];
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => {
        ran.push(identity.id);
        return { report: identity.id === 'a' ? 'verdict: APPROVED' : identity.id, ok: true };
      },
    });
    expect(ran.sort()).toEqual(['a', 'approve']);
    expect(result.skipped).toEqual(['reject']);
    expect(result.answer).toBe('approve');
  });

  it('conditional short-circuit cascades releases downstream', async () => {
    // a → gated → tail: when the gate fails, `gated` is skipped AND `tail`
    // (which waits only on `gated`) is released and skipped too.
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('gated'), node('tail')],
      edges: [
        { from: 'a', to: 'gated', condition: 'NEVER-MATCHES' },
        { from: 'gated', to: 'tail' },
      ],
    });
    const ran: string[] = [];
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => {
        ran.push(identity.id);
        return { report: identity.id, ok: true };
      },
    });
    expect(ran).toEqual(['a']);
    expect(result.skipped.sort()).toEqual(['gated', 'tail']);
    expect(result.answer).toBe('a');
  });

  it('OR-join (join: any) wakes on the first delivered in-edge only', async () => {
    const def = graphDef({
      nodes: [
        node('fast', { entry: true }),
        node('slow', { entry: true }),
        node('first', { join: 'any' }),
      ],
      edges: [
        { from: 'fast', to: 'first' },
        { from: 'slow', to: 'first' },
      ],
    });
    const runs: Array<{ id: string; task: string }> = [];
    await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity, task) => {
        runs.push({ id: identity.id, task });
        if (identity.id === 'slow') await new Promise((r) => setTimeout(r, 30));
        return { report: `out-${identity.id}`, ok: true };
      },
    });
    const firstRuns = runs.filter((r) => r.id === 'first');
    expect(firstRuns).toHaveLength(1);
    expect(firstRuns[0]!.task).toContain('out-fast');
    expect(firstRuns[0]!.task).not.toContain('out-slow');
  });

  it('communication edges: notify wakes the target with the pushed message', async () => {
    const def = graphDef({
      nodes: [node('sender', { entry: true }), node('listener')],
      edges: [{ from: 'sender', to: 'listener', trigger: 'on_tool_call', channel: 'handoff' }],
    });
    const events: TeamEvent[] = [];
    const tasks: Record<string, string> = {};
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      onEvent: (e) => events.push(e),
      runNode: async (_node, identity, task, ctx) => {
        tasks[identity.id] = task;
        if (identity.id === 'sender') {
          expect(ctx.commTargets).toEqual(['listener']);
          const outcome = ctx.notify('listener', 'take over: check auth.ts');
          expect(outcome.ok).toBe(true);
          expect(outcome.delivered).toEqual(['listener']);
        }
        return { report: `out-${identity.id}`, ok: true };
      },
    });
    expect(tasks.listener).toContain('take over: check auth.ts');
    expect(result.skipped).toEqual([]);
    const edge = events.find((e) => e.type === 'team.edge.triggered');
    expect(edge).toMatchObject({ from: 'sender', to: 'listener', trigger: 'on_tool_call', channel: 'handoff' });
  });

  it("notify '*' broadcasts along all communication edges", async () => {
    const def = graphDef({
      nodes: [node('hub', { entry: true }), node('x'), node('y')],
      edges: [
        { from: 'hub', to: 'x', trigger: 'on_handoff', channel: 'broadcast' },
        { from: 'hub', to: 'y', trigger: 'on_handoff', channel: 'broadcast' },
      ],
    });
    const ran: string[] = [];
    await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity, _task, ctx) => {
        ran.push(identity.id);
        if (identity.id === 'hub') {
          const outcome = ctx.notify('*', 'fan-out');
          expect(outcome.delivered.sort()).toEqual(['x', 'y']);
        }
        return { report: identity.id, ok: true };
      },
    });
    expect(ran.sort()).toEqual(['hub', 'x', 'y']);
  });

  it('notify reports invalid targets and drops messages to running nodes', async () => {
    const def = graphDef({
      nodes: [node('sender', { entry: true }), node('other', { entry: true })],
      edges: [{ from: 'sender', to: 'other', trigger: 'on_tool_call' }],
    });
    await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity, _task, ctx) => {
        if (identity.id === 'sender') {
          expect(ctx.notify('ghost', 'hello').ok).toBe(false);
          expect(ctx.notify('ghost', 'hello').error).toContain('no communication edge');
          // `other` is an entry — already running — so the push is dropped.
          const dropped = ctx.notify('other', 'late message');
          expect(dropped.ok).toBe(false);
          expect(dropped.error).toContain('not delivered');
        }
        if (identity.id === 'other') {
          expect(ctx.commTargets).toEqual([]);
          expect(ctx.notify('sender', 'nope').error).toContain('no communication edges');
        }
        return { report: identity.id, ok: true };
      },
    });
  });

  it('a communication-only target that is never notified is skipped', async () => {
    const def = graphDef({
      nodes: [node('sender', { entry: true }), node('quiet')],
      edges: [{ from: 'sender', to: 'quiet', trigger: 'on_tool_call' }],
    });
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => ({ report: identity.id, ok: true }),
    });
    expect(result.skipped).toEqual(['quiet']);
  });

  it('NotifyTeammate tool delivers through ctx.notify', async () => {
    const calls: Array<{ to: string; message: string }> = [];
    const ctx: GraphNodeRunContext = {
      commTargets: ['reviewer'],
      notify: (to, message) => {
        calls.push({ to, message });
        return { ok: true, delivered: ['reviewer'] };
      },
    };
    const notifyTool = await createNotifyTeammateTool(ctx);
    expect(notifyTool.name).toBe('NotifyTeammate');
    expect(notifyTool.description).toContain('reviewer');
    const outcome = await notifyTool.execute(
      { to: 'reviewer', message: 'please check' } as never,
      {} as never,
    );
    expect(calls).toEqual([{ to: 'reviewer', message: 'please check' }]);
    expect(String(outcome)).toContain('Delivered to: reviewer');
  });

  it('executes a diamond DAG in topological order with parallel entries', async () => {
    // a → (b, c) → d — b and c both wait on a; d wait-alls b+c.
    const def = graphDef({
      nodes: [node('a', { entry: true }), node('b'), node('c'), node('d')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    });
    const order: string[] = [];
    const result = await orchestrateGraph({
      prompt: 'P',
      definition: def,
      runNode: async (_node, identity) => {
        order.push(identity.id);
        // Stagger completions to exercise the async join accounting.
        await new Promise((r) => setTimeout(r, identity.id === 'b' ? 20 : 5));
        return { report: identity.id, ok: true };
      },
    });

    expect(order[0]).toBe('a');
    expect(order.indexOf('d')).toBe(3);
    expect(result.answer).toBe('d');
    expect(result.reports).toHaveLength(4);
  });
});

// Phase 4 acceptance: the exact artifact an editor persists (save → disk →
// load) is directly executable by the engine, with no massaging in between.
describe('editor artifact → engine (end to end)', () => {
  it('a saved graph definition round-trips through disk and executes', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { saveTeamDefinition, loadTeamDefinition } = await import('../src/team/teamDefinitions.js');

    const tmpDir = path.join(os.tmpdir(), `actoviq-graph-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(tmpDir, '.actoviq', 'teams'), { recursive: true });
    try {
      // What the GUI graph editor produces: nodes + edges + entry + condition
      // + allowedTools + a communication edge.
      const editorArtifact: TeamDefinition = graphDef({
        name: 'editor-e2e',
        nodes: [
          node('planner', { entry: true, allowedTools: ['Read', 'Grep'], ui: { x: 72, y: 48 } }),
          node('builder', { ui: { x: 322, y: 238 } }),
          node('reviewer', { join: 'any', ui: { x: 572, y: 428 } }),
        ],
        edges: [
          { from: 'planner', to: 'builder', payloadTemplate: 'PLAN:\n{{from.output}}' },
          { from: 'builder', to: 'reviewer', condition: '/done/i' },
          { from: 'planner', to: 'reviewer', trigger: 'on_tool_call', channel: 'review' },
        ],
      });
      expect(validateTeamGraph(editorArtifact)).toEqual([]);
      await saveTeamDefinition(editorArtifact, { projectDir: tmpDir });

      const loaded = loadTeamDefinition('editor-e2e', tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.definition.mode).toBe('graph');
      expect(loaded!.definition.version).toBe(3);
      expect(loaded!.definition.nodes?.some((n) => n.kind === 'task')).toBe(true);
      expect(loaded!.definition.nodes?.some((n) => n.kind === 'return')).toBe(true);
      const agentUi = loaded!.definition.nodes?.find((n) => n.id === 'planner');
      expect(agentUi?.ui).toEqual({ x: 72, y: 48 });
      expect(validateTeamGraph(loaded!.definition)).toEqual([]);

      const order: string[] = [];
      const result = await orchestrateGraph({
        prompt: 'Build the feature',
        definition: loaded!.definition,
        runNode: async (_node, identity, task) => {
          order.push(identity.id);
          if (identity.id === 'builder') expect(task).toContain('PLAN:');
          return { report: identity.id === 'builder' ? 'DONE — shipped' : identity.id, ok: true };
        },
      });
      expect(order).toEqual(['planner', 'builder', 'reviewer']);
      expect(result.skipped).toEqual([]);
      // v3 void Return: terminal agent output is not promoted to answer.
      expect(result.returnMode).toBe('void');
      expect(result.answer).toBe('');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
