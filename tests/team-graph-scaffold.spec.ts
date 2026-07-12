/**
 * Graph team scaffolds + insertable Parallel / Loop blocks.
 */
import { describe, it, expect } from 'vitest';
import { validateTeamGraph } from '../src/team/teamGraph.js';
import {
  buildGraphTeamFromTemplate,
  insertLoopAsNestedTeam,
  insertLoopBlock,
  insertParallelAsNestedTeam,
  insertParallelBlock,
  scaffoldMinimalGraphTeam,
  scaffoldParallelPanelGraph,
  scaffoldReviewLoopGraph,
} from '../src/team/teamGraphScaffold.js';

describe('teamGraphScaffold', () => {
  it('scaffoldMinimalGraphTeam passes validateTeamGraph', () => {
    const def = scaffoldMinimalGraphTeam('blank-graph');
    expect(validateTeamGraph(def)).toEqual([]);
    expect(def.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(def.nodes?.some((n) => n.kind === 'return')).toBe(true);
  });

  it('scaffoldParallelPanelGraph fans out to ≥2 members + synthesizer', () => {
    const def = scaffoldParallelPanelGraph('panel', {
      members: [
        { id: 'researcher', role: 'researcher' },
        { id: 'skeptic', role: 'skeptic' },
      ],
      synthesizer: true,
      join: 'all',
    });
    expect(validateTeamGraph(def)).toEqual([]);
    expect(def.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(def.edges?.filter((e) => e.from === 'task')).toHaveLength(2);
    expect(def.nodes?.some((n) => (n.id || n.role) === 'synthesizer')).toBe(true);
  });

  it('scaffoldReviewLoopGraph has loop + FINALIZE exit and maxRounds', () => {
    const def = scaffoldReviewLoopGraph('review', { maxRounds: 6 });
    expect(validateTeamGraph(def)).toEqual([]);
    expect(def.maxRounds).toBe(6);
    expect(def.edges?.some((e) => e.loop)).toBe(true);
    expect(def.edges?.some((e) => e.condition === 'FINALIZE')).toBe(true);
  });

  it('buildGraphTeamFromTemplate covers blank / parallel / review-loop', () => {
    for (const template of ['blank', 'parallel', 'review-loop'] as const) {
      const def = buildGraphTeamFromTemplate(`t-${template}`, template);
      expect(validateTeamGraph(def)).toEqual([]);
      expect(def.squadType).toBe('graph');
    }
  });

  it('insertParallelBlock keeps a single Task', () => {
    const base = scaffoldMinimalGraphTeam('host');
    const next = insertParallelBlock(base, {
      members: [
        { id: 'a', role: 'a' },
        { id: 'b', role: 'b' },
      ],
      synthesizer: true,
    });
    expect(validateTeamGraph(next)).toEqual([]);
    expect(next.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(next.nodes?.some((n) => n.id === 'a')).toBe(true);
    expect(next.nodes?.some((n) => n.id === 'b')).toBe(true);
  });

  it('insertLoopBlock adds CONTINUE/FINALIZE without a second Task', () => {
    const base = scaffoldMinimalGraphTeam('host-loop');
    const next = insertLoopBlock(base, { maxRounds: 4 });
    expect(validateTeamGraph(next)).toEqual([]);
    expect(next.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(next.edges?.some((e) => e.loop && e.condition === 'CONTINUE')).toBe(true);
    expect(next.edges?.some((e) => e.condition === 'FINALIZE')).toBe(true);
    expect(next.maxRounds).toBeGreaterThanOrEqual(4);
  });

  it('insertParallelAsNestedTeam writes child + parent teamRef node', () => {
    const parent = scaffoldMinimalGraphTeam('parent-p');
    const { definition, nested } = insertParallelAsNestedTeam(parent, {
      nestedName: 'parent-p-parallel',
      members: [
        { id: 'researcher' },
        { id: 'skeptic' },
      ],
    });
    expect(validateTeamGraph(nested)).toEqual([]);
    expect(validateTeamGraph(definition)).toEqual([]);
    expect(definition.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    const teamNode = definition.nodes?.find((n) => n.type === 'team');
    expect(teamNode?.teamRef).toBe('parent-p-parallel');
  });

  it('insertLoopAsNestedTeam keeps one Task on parent', () => {
    const parent = scaffoldMinimalGraphTeam('parent-l');
    const { definition, nested } = insertLoopAsNestedTeam(parent, {
      nestedName: 'parent-l-loop',
      maxRounds: 5,
    });
    expect(validateTeamGraph(nested)).toEqual([]);
    expect(validateTeamGraph(definition)).toEqual([]);
    expect(definition.nodes?.filter((n) => n.kind === 'task')).toHaveLength(1);
    expect(definition.nodes?.some((n) => n.type === 'team' && n.teamRef === 'parent-l-loop')).toBe(true);
    expect(nested.edges?.some((e) => e.loop)).toBe(true);
  });
});
