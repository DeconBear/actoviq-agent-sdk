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
  edgeBezierMaxControlDistance,
  clearEdgeBezierUiForNodeRef,
} from '../src/team/teamGraphLayout.js';
import { toPersistedTeamDefinition } from '../src/team/teamGraph.js';
import { getBuiltInTeamDefinition } from '../src/team/teamDefinitions.js';
import type { TeamDefinition, TeamGraphEdge } from '../src/types.js';

describe('teamGraphLayout', () => {
  it('resolveEdgeBezierPoints uses stored offsets when within clamp budget', () => {
    const p1 = { x: 100, y: 50 };
    const p2 = { x: 300, y: 200 };
    const { path, c1, c2 } = resolveEdgeBezierPoints(p1, p2, {
      c1: { dx: 30, dy: 50 },
      c2: { dx: -20, dy: -40 },
    });
    expect(c1).toEqual({ x: 130, y: 100 });
    expect(c2).toEqual({ x: 280, y: 160 });
    expect(path).toContain('130 100');
    expect(path).toContain('280 160');
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

  it('defaultEdgeBezierOffsets caps tension on long edges', () => {
    const off = defaultEdgeBezierOffsets({ x: 0, y: 0 }, { x: 0, y: 900 });
    expect(Math.abs(off.c1.dy)).toBeLessThanOrEqual(96);
    expect(Math.abs(off.c2.dy)).toBeLessThanOrEqual(96);
  });

  it('defaultEdgeBezierOffsets curves horizontal edges', () => {
    const off = defaultEdgeBezierOffsets({ x: 0, y: 100 }, { x: 400, y: 110 });
    expect(Math.abs(off.c1.dx)).toBeGreaterThan(30);
    expect(Math.abs(off.c1.dx)).toBeLessThanOrEqual(96);
  });

  it('resolveEdgeBezierPoints clamps wild stored offsets', () => {
    const p1 = { x: 100, y: 100 };
    const p2 = { x: 200, y: 260 };
    const max = edgeBezierMaxControlDistance(p1, p2);
    const { c1, c2 } = resolveEdgeBezierPoints(p1, p2, {
      c1: { dx: 900, dy: 1200 },
      c2: { dx: -700, dy: -800 },
    });
    expect(Math.hypot(c1.x - p1.x, c1.y - p1.y)).toBeLessThanOrEqual(max + 0.001);
    expect(Math.hypot(c2.x - p2.x, c2.y - p2.y)).toBeLessThanOrEqual(max + 0.001);
  });

  it('writeEdgeBezierUi clamps dragged control points', () => {
    const edge: TeamGraphEdge = { from: 'a', to: 'b' };
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 180, y: 220 };
    writeEdgeBezierUi(edge, p1, p2, { x: 800, y: 900 }, { x: -500, y: -400 });
    const max = edgeBezierMaxControlDistance(p1, p2);
    expect(Math.hypot(edge.ui!.c1!.dx, edge.ui!.c1!.dy)).toBeLessThanOrEqual(max + 0.001);
    expect(Math.hypot(edge.ui!.c2!.dx, edge.ui!.c2!.dy)).toBeLessThanOrEqual(max + 0.001);
  });

  it('clearEdgeBezierUiForNodeRef clears touching edges only', () => {
    const def: TeamDefinition = {
      name: 't',
      mode: 'graph',
      members: [],
      edges: [
        { from: 'a', to: 'b', ui: { c1: { dx: 10, dy: 10 }, c2: { dx: -10, dy: -10 } } },
        { from: 'c', to: 'd', ui: { c1: { dx: 5, dy: 5 }, c2: { dx: -5, dy: -5 } } },
      ],
    };
    clearEdgeBezierUiForNodeRef(def, 'b');
    expect(def.edges![0].ui).toBeUndefined();
    expect(def.edges![1].ui).toBeDefined();
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
