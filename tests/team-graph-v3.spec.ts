/**
 * Team graph orchestration v3 — Task entry + Return exit ports.
 */
import { describe, it, expect } from 'vitest';
import {
  migrateTeamDefinitionToV3,
  migrateTeamDefinitionToGraph,
  validateTeamGraphV3,
  isTeamGraphV3,
  orchestrateGraph,
} from '../src/team/teamGraph.js';
import type { TeamDefinition, TeamEvent, TeamGraphNode } from '../src/types.js';

function v3Def(partial: Partial<TeamDefinition>): TeamDefinition {
  return {
    name: 'v3-test',
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    members: [],
    nodes: [
      { kind: 'task', id: 'task', ui: { x: 0, y: 0 } },
      { kind: 'agent', id: 'a', model: 'm1', ui: { x: 100, y: 0 } },
      { kind: 'return', id: 'return-void', returnMode: 'void', ui: { x: 200, y: 0 } },
    ],
    edges: [
      { from: 'task', to: 'a', payloadTemplate: '{{run.prompt}}' },
      { from: 'a', to: 'return-void' },
    ],
    ...partial,
  };
}

const agent = (id: string, extra: Partial<TeamGraphNode> = {}): TeamGraphNode => ({
  kind: 'agent',
  id,
  model: 'test-model',
  ...extra,
});

describe('isTeamGraphV3 / validateTeamGraphV3', () => {
  it('detects v3 graphs by version or port nodes', () => {
    expect(isTeamGraphV3(v3Def({}))).toBe(true);
    expect(isTeamGraphV3({ name: 'x', mode: 'graph', version: 2, members: [], nodes: [agent('a')] })).toBe(false);
  });

  it('requires exactly one Task and at least one Return', () => {
    const missingReturn = v3Def({ nodes: [{ kind: 'task', id: 'task' }, agent('a')] });
    expect(validateTeamGraphV3(missingReturn).some((e) => e.includes('Return'))).toBe(true);

    const twoTasks = v3Def({
      nodes: [
        { kind: 'task', id: 'task' },
        { kind: 'task', id: 'task2' },
        { kind: 'return', id: 'return-void', returnMode: 'void' },
      ],
    });
    expect(validateTeamGraphV3(twoTasks).some((e) => e.includes('exactly one Task'))).toBe(true);
  });

  it('requires a path from Task to Return', () => {
    const def = v3Def({
      edges: [{ from: 'task', to: 'a' }],
    });
    expect(validateTeamGraphV3(def).some((e) => e.includes('no path from Task'))).toBe(true);
  });

  it('requires maxRounds when loop edges exist', () => {
    const def = v3Def({
      edges: [
        { from: 'task', to: 'a', payloadTemplate: '{{run.prompt}}' },
        { from: 'a', to: 'return-void' },
        { from: 'a', to: 'task', loop: true, condition: 'CONTINUE' },
      ],
    });
    expect(validateTeamGraphV3(def).some((e) => e.includes('maxRounds'))).toBe(true);
    expect(validateTeamGraphV3({ ...def, maxRounds: 5 })).toEqual([]);
  });
});

describe('migrateTeamDefinitionToV3', () => {
  it('inserts Task + Return for a v2 pipeline', () => {
    const v2 = {
      name: 'pipe',
      mode: 'graph' as const,
      version: 2,
      orchestration: 'graph' as const,
      members: [],
      nodes: [agent('a', { entry: true }), agent('b')],
      edges: [{ from: 'a', to: 'b' }],
    };
    const v3 = migrateTeamDefinitionToV3(v2);
    expect(v3.version).toBe(3);
    expect(v3.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(v3.nodes?.filter((n) => n.kind === 'return')).toHaveLength(1);
    expect(v3.edges?.some((e) => e.from === 'task' && e.to === 'a')).toBe(true);
    expect(v3.edges?.some((e) => e.from === 'b' && e.to === 'return-void')).toBe(true);
    expect(validateTeamGraphV3(v3)).toEqual([]);
  });

  it('adds loop edges when primary is present', () => {
    const v2 = {
      name: 'panel',
      mode: 'graph' as const,
      version: 2,
      orchestration: 'graph' as const,
      members: [],
      primary: { id: 'lead', model: 'm1' },
      nodes: [agent('lead', { entry: true, id: 'lead' }), agent('peer')],
      edges: [{ from: 'lead', to: 'peer' }],
    };
    const v3 = migrateTeamDefinitionToV3(v2);
    expect(v3.edges?.some((e) => e.from === 'lead' && e.to === 'task' && e.loop)).toBe(true);
    expect(v3.edges?.some((e) => e.from === 'lead' && e.to === 'return-void' && e.condition === 'FINALIZE')).toBe(true);
    expect(v3.maxRounds).toBeGreaterThanOrEqual(2);
  });

  it('migrateTeamDefinitionToGraph is idempotent for v3', () => {
    const base = v3Def({});
    const again = migrateTeamDefinitionToGraph(base);
    expect(again.nodes?.length).toBe(base.nodes?.length);
    expect(again.version).toBe(3);
  });
});

describe('orchestrateGraph v3 engine', () => {
  it('dispatches run prompt from Task and returns void', async () => {
    const events: TeamEvent[] = [];
    const tasks: string[] = [];
    const result = await orchestrateGraph({
      definition: v3Def({}),
      prompt: 'hello task',
      runNode: async (_node, identity, task) => {
        tasks.push(task);
        return { ok: true, report: `done:${identity.id}` };
      },
      onEvent: (e) => events.push(e),
    });
    expect(tasks).toEqual(['hello task']);
    expect(result.returnMode).toBe('void');
    expect(result.returnValue).toBeNull();
    expect(result.returnNodeId).toBe('return-void');
    expect(events.some((e) => e.type === 'team.returned')).toBe(true);
  });

  it('returns payload from a payload Return port', async () => {
    const def = v3Def({
      nodes: [
        { kind: 'task', id: 'task' },
        agent('a'),
        { kind: 'return', id: 'return', returnMode: 'payload', payloadTemplate: 'OUT: {{from.output}}' },
      ],
      edges: [
        { from: 'task', to: 'a', payloadTemplate: '{{run.prompt}}' },
        { from: 'a', to: 'return' },
      ],
    });
    const result = await orchestrateGraph({
      definition: def,
      prompt: 'review this',
      runNode: async () => ({ ok: true, report: 'findings here' }),
    });
    expect(result.returnMode).toBe('payload');
    expect(result.returnValue).toContain('findings here');
    expect(result.answer).toContain('findings here');
  });

  it('loops back to Task when loop edge condition passes', async () => {
    const def = v3Def({
      maxRounds: 3,
      nodes: [
        { kind: 'task', id: 'task' },
        agent('lead'),
        { kind: 'return', id: 'return-void', returnMode: 'void' },
      ],
      edges: [
        { from: 'task', to: 'lead', payloadTemplate: '{{run.prompt}}' },
        { from: 'lead', to: 'return-void', condition: 'FINALIZE' },
        { from: 'lead', to: 'task', loop: true, condition: 'CONTINUE' },
      ],
    });
    let calls = 0;
    const result = await orchestrateGraph({
      definition: def,
      prompt: 'round test',
      runNode: async () => {
        calls += 1;
        return { ok: true, report: calls < 2 ? 'CONTINUE' : 'FINALIZE' };
      },
    });
    expect(calls).toBe(2);
    expect(result.rounds).toBe(2);
    expect(result.returnMode).toBe('void');
  });
});
