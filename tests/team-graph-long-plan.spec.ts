import { describe, expect, it } from 'vitest';
import {
  pickShortestSides,
  sideAnchor,
  migrateLegacyEdgeSides,
  computeGroupBounds,
} from '../src/team/teamGraphLayout.js';
import { migrateTeamDefinitionToV3, validateTeamGraphV3, sanitizeV3GraphTopology } from '../src/team/teamGraphV3.js';
import { finalizeTeamProposeDraft } from '../src/team/teamPropose.js';
import type { TeamDefinition, TeamGraphEdge } from '../src/types.js';

describe('pickShortestSides', () => {
  it('prefers vertical sides for stacked nodes', () => {
    const from = { x: 100, y: 0, w: 160, h: 70 };
    const to = { x: 100, y: 200, w: 160, h: 70 };
    const pick = pickShortestSides(from, to);
    expect(pick.fromSide).toBe('s');
    expect(pick.toSide).toBe('n');
  });

  it('prefers horizontal sides for side-by-side / loop geometry', () => {
    const from = { x: 0, y: 100, w: 160, h: 70 };
    const to = { x: 280, y: 100, w: 160, h: 70 };
    const pick = pickShortestSides(from, to);
    expect(pick.fromSide).toBe('e');
    expect(pick.toSide).toBe('w');
  });

  it('sideAnchor places center port on each side', () => {
    const rect = { x: 0, y: 0, w: 100, h: 50 };
    expect(sideAnchor(rect, 'n', 1, 3)).toEqual({ x: 50, y: 0 });
    expect(sideAnchor(rect, 's', 1, 3)).toEqual({ x: 50, y: 50 });
    expect(sideAnchor(rect, 'w', 1, 3)).toEqual({ x: 0, y: 25 });
    expect(sideAnchor(rect, 'e', 1, 3)).toEqual({ x: 100, y: 25 });
  });

  it('migrateLegacyEdgeSides defaults to s→n', () => {
    const edge: TeamGraphEdge = { from: 'a', to: 'b' };
    migrateLegacyEdgeSides(edge);
    expect(edge.ui?.fromSide).toBe('s');
    expect(edge.ui?.toSide).toBe('n');
  });
  it('searches all snap ports when indices are omitted', () => {
    const from = { x: 0, y: 0, w: 160, h: 70 };
    const to = { x: 40, y: 200, w: 160, h: 70 };
    const pick = pickShortestSides(from, to, { fromPortCount: 5, toPortCount: 5 });
    expect(pick.fromSide).toBe('s');
    expect(pick.toSide).toBe('n');
    expect(pick.fromPort).toBeGreaterThanOrEqual(0);
    expect(pick.fromPort).toBeLessThan(5);
  });

  it('preserves explicitly selected ports while choosing the shortest sides', () => {
    const from = { x: 0, y: 0, w: 160, h: 70 };
    const to = { x: 260, y: 140, w: 160, h: 70 };
    const pick = pickShortestSides(from, to, {
      fromPort: 0,
      toPort: 2,
      fromPortCount: 3,
      toPortCount: 3,
    });
    expect(pick).toEqual({
      fromSide: 'e',
      toSide: 'w',
      fromPort: 0,
      toPort: 2,
    });
  });

  it('uses the true shortest anchor pair for diagonal nodes', () => {
    const from = { x: 0, y: 0, w: 160, h: 70 };
    const to = { x: 140, y: 130, w: 160, h: 70 };
    const pick = pickShortestSides(from, to, {
      fromPortCount: 3,
      toPortCount: 3,
    });
    expect(pick).toEqual({
      fromSide: 'e',
      toSide: 'n',
      fromPort: 2,
      toPort: 0,
    });
  });
});

describe('computeGroupBounds', () => {
  it('unions member node boxes', () => {
    const nodes = [
      { id: 'a', ui: { x: 10, y: 20 } },
      { id: 'b', ui: { x: 100, y: 40 } },
      { id: 'c', ui: { x: 0, y: 0 } },
    ];
    const bounds = computeGroupBounds(
      nodes,
      ['a', 'b'],
      (n) => (n as { id: string }).id,
      () => ({ w: 50, h: 30 }),
    );
    expect(bounds).toEqual({ x: 10, y: 20, w: 140, h: 50 });
  });
});

describe('single Caller Exit', () => {
  it('validate requires exactly one Return', () => {
    const none: TeamDefinition = {
      name: 't',
      mode: 'graph',
      version: 3,
      members: [],
      nodes: [
        { kind: 'task', id: 'task' },
        { id: 'a', model: 'm' },
      ],
      edges: [{ from: 'task', to: 'a' }],
    };
    expect(validateTeamGraphV3(none).some((e) => e.includes('exactly one Caller Exit'))).toBe(true);

    const two: TeamDefinition = {
      ...none,
      nodes: [
        { kind: 'task', id: 'task' },
        { id: 'a', model: 'm' },
        { kind: 'return', id: 'r1', returnMode: 'void' },
        { kind: 'return', id: 'r2', returnMode: 'payload' },
      ],
      edges: [
        { from: 'task', to: 'a' },
        { from: 'a', to: 'r1' },
        { from: 'a', to: 'r2' },
      ],
    };
    expect(validateTeamGraphV3(two).some((e) => e.includes('exactly one Caller Exit'))).toBe(true);
  });

  it('sanitize consolidates multiple Returns into one', () => {
    const def: TeamDefinition = {
      name: 'multi',
      mode: 'graph',
      version: 3,
      members: [],
      nodes: [
        { kind: 'task', id: 'task' },
        { id: 'a', model: 'm1' },
        { kind: 'return', id: 'return-void', returnMode: 'void' },
        { kind: 'return', id: 'return', returnMode: 'payload' },
      ],
      edges: [
        { from: 'task', to: 'a' },
        { from: 'a', to: 'return-void' },
        { from: 'a', to: 'return' },
      ],
    };
    const next = sanitizeV3GraphTopology(structuredClone(def));
    expect(next.nodes?.filter((n) => n.kind === 'return')).toHaveLength(1);
    expect(next.nodes?.find((n) => n.kind === 'return')?.returnMode).toBe('void');
    expect(validateTeamGraphV3(next)).toEqual([]);
  });

  it('migrate still yields exactly one Return', () => {
    const v2 = {
      name: 'pipe',
      mode: 'graph' as const,
      version: 2,
      orchestration: 'graph' as const,
      members: [],
      nodes: [
        { id: 'a', model: 'm', entry: true },
        { id: 'b', model: 'm' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const v3 = migrateTeamDefinitionToV3(v2);
    expect(v3.nodes?.filter((n) => n.kind === 'return')).toHaveLength(1);
    expect(validateTeamGraphV3(v3)).toEqual([]);
  });
});

describe('finalizeTeamProposeDraft', () => {
  it('returns problems with draft when validation fails', () => {
    const raw = JSON.stringify({
      explanation: 'bad draft',
      definition: {
        name: 'bad',
        mode: 'graph',
        version: 3,
        members: [],
        nodes: [{ kind: 'task', id: 'task' }, { id: 'a', model: 'm' }],
        edges: [{ from: 'task', to: 'a' }],
      },
    });
    const result = finalizeTeamProposeDraft(raw, { squadType: 'graph' });
    expect(result.definition).toBeTruthy();
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.explanation).toBe('bad draft');
  });

  it('accepts a valid minimal graph draft', () => {
    const raw = JSON.stringify({
      explanation: 'ok',
      definition: {
        name: 'ok',
        mode: 'graph',
        version: 3,
        members: [],
        nodes: [
          { kind: 'task', id: 'task' },
          { id: 'a', model: 'm' },
          { kind: 'return', id: 'return-void', returnMode: 'void' },
        ],
        edges: [
          { from: 'task', to: 'a' },
          { from: 'a', to: 'return-void' },
        ],
      },
    });
    const result = finalizeTeamProposeDraft(raw, { squadType: 'graph' });
    expect(result.problems).toEqual([]);
    expect(result.definition?.nodes?.some((n) => n.kind === 'return')).toBe(true);
  });
});
