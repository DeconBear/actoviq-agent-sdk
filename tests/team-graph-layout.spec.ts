/**
 * GUI edge bezier layout helpers — offsets persist in squad JSON.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultEdgeBezierOffsets,
  resolveEdgeBezierPoints,
  writeEdgeBezierUi,
  clearEdgeBezierUi,
  computeTeamGraphAutoLayoutLanes,
} from '../src/team/teamGraphLayout.js';
import { toPersistedTeamDefinition } from '../src/team/teamGraph.js';
import { getBuiltInTeamDefinition } from '../src/team/teamDefinitions.js';
import type { TeamDefinition, TeamGraphEdge } from '../src/types.js';

describe('teamGraphLayout', () => {
  it('resolveEdgeBezierPoints uses stored offsets when present', () => {
    const p1 = { x: 100, y: 50 };
    const p2 = { x: 300, y: 200 };
    const { path, c1, c2 } = resolveEdgeBezierPoints(p1, p2, {
      c1: { dx: 40, dy: 80 },
      c2: { dx: -30, dy: -60 },
    });
    expect(c1).toEqual({ x: 140, y: 130 });
    expect(c2).toEqual({ x: 270, y: 140 });
    expect(path).toContain('140 130');
    expect(path).toContain('270 140');
  });

  it('writeEdgeBezierUi stores offsets relative to ports', () => {
    const edge: TeamGraphEdge = { from: 'a', to: 'b' };
    writeEdgeBezierUi(edge, { x: 0, y: 0 }, { x: 200, y: 100 }, { x: 10, y: 40 }, { x: 190, y: 70 });
    expect(edge.ui).toEqual({
      c1: { dx: 10, dy: 40 },
      c2: { dx: -10, dy: -30 },
    });
    clearEdgeBezierUi(edge);
    expect(edge.ui).toBeUndefined();
  });

  it('toPersistedTeamDefinition keeps edge.ui layout metadata', () => {
    const def: TeamDefinition = {
      name: 'layout-test',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      members: [],
      nodes: [
        { kind: 'task', id: 'task', ui: { x: 10, y: 20 } },
        { kind: 'agent', id: 'a', model: 'm1', ui: { x: 100, y: 120 } },
        { kind: 'return', id: 'return-void', returnMode: 'void', ui: { x: 400, y: 220 } },
      ],
      edges: [
        { from: 'task', to: 'a', ui: { c1: { dx: 0, dy: 48 }, c2: { dx: 0, dy: -48 } } },
        { from: 'a', to: 'return-void' },
      ],
    };
    const saved = toPersistedTeamDefinition(def);
    expect(saved.edges?.[0]?.ui?.c1).toEqual({ dx: 0, dy: 48 });
    expect(saved.nodes?.[1]?.ui).toEqual({ x: 100, y: 120 });
  });

  it('defaultEdgeBezierOffsets scales with vertical distance', () => {
    const off = defaultEdgeBezierOffsets({ x: 0, y: 0 }, { x: 0, y: 200 });
    expect(off.c1.dy).toBeGreaterThan(0);
    expect(off.c2.dy).toBeLessThan(0);
  });

  it('defaultEdgeBezierOffsets curves horizontal edges', () => {
    const off = defaultEdgeBezierOffsets({ x: 0, y: 100 }, { x: 400, y: 110 });
    expect(Math.abs(off.c1.dx)).toBeGreaterThan(40);
    expect(Math.abs(off.c2.dx)).toBeGreaterThan(40);
  });

  it('computeTeamGraphAutoLayoutLanes separates synthesizer from panel members', () => {
    const def = getBuiltInTeamDefinition('panel-analysis');
    expect(def).toBeDefined();
    const lanes = computeTeamGraphAutoLayoutLanes(def!);
    const nodes = def!.nodes ?? [];
    const rowOf = (ref: string) => lanes.findIndex((row) => row.some((i) => (nodes[i]?.id ?? nodes[i]?.name) === ref));
    expect(rowOf('task')).toBe(0);
    expect(rowOf('researcher')).toBe(1);
    expect(rowOf('skeptic')).toBe(1);
    expect(rowOf('synthesizer')).toBeGreaterThan(rowOf('researcher'));
    expect(rowOf('return-void')).toBe(lanes.length - 1);
  });
});
