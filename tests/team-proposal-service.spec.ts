import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TeamDefinition } from '../src/types.js';
import {
  TeamProposalConflictError,
  TeamProposalStore,
  mergeTeamProposalLayout,
} from '../src/team/teamProposalService.js';
import { loadTeamDefinition, saveTeamDefinition } from '../src/team/teamDefinitions.js';

let projectDir: string;
let homeDir: string;

function graph(name = 'review-loop'): TeamDefinition {
  return {
    name,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    members: [],
    maxRounds: 3,
    nodes: [
      { kind: 'task', id: 'task', ui: { x: 20, y: 30 } },
      { kind: 'agent', id: 'worker', model: 'model-a', ui: { x: 80, y: 140 } },
      { kind: 'agent', id: 'reviewer', model: 'model-b', ui: { x: 300, y: 140 } },
      { kind: 'return', id: 'return', returnMode: 'payload', ui: { x: 180, y: 360 } },
    ],
    edges: [
      { from: 'task', to: 'worker' },
      { from: 'worker', to: 'reviewer' },
      {
        from: 'reviewer',
        to: 'worker',
        loop: true,
        condition: 'CHANGES_REQUIRED',
        ui: {
          fromSide: 'e',
          toSide: 'e',
          fromPort: 2,
          toPort: 0,
          sideLocked: true,
          c1: { dx: 140, dy: 0 },
          c2: { dx: 140, dy: 0 },
        },
      },
      { from: 'reviewer', to: 'return', condition: 'APPROVED' },
    ],
  };
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-project-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-home-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('TeamProposalStore', () => {
  it('stages without writing and writes only after Apply', async () => {
    const store = new TeamProposalStore();
    const proposal = store.stage({
      assistantSessionId: 'assistant-1',
      projectPath: projectDir,
      definition: graph(),
      explanation: 'Add a bounded reviewer loop.',
      homeDir,
    });
    expect(proposal.problems).toEqual([]);
    expect(proposal.diff.addedNodes).toContain('reviewer');
    expect(loadTeamDefinition('review-loop', projectDir, homeDir)).toBeNull();

    const applied = await store.apply(proposal.id, homeDir);
    expect(fs.existsSync(applied.filePath)).toBe(true);
    expect(loadTeamDefinition('review-loop', projectDir, homeDir)?.definition.maxRounds).toBe(3);
  });

  it('Reject never writes a Team file', () => {
    const store = new TeamProposalStore();
    const proposal = store.stage({
      assistantSessionId: 'assistant-1',
      projectPath: projectDir,
      definition: graph(),
      homeDir,
    });
    expect(store.reject(proposal.id).status).toBe('rejected');
    expect(loadTeamDefinition('review-loop', projectDir, homeDir)).toBeNull();
  });

  it('blocks invalid proposals and reports validation problems', async () => {
    const invalid = graph();
    invalid.edges = [{ from: 'missing', to: 'worker' }];
    const store = new TeamProposalStore();
    const proposal = store.stage({
      assistantSessionId: 'assistant-1',
      projectPath: projectDir,
      definition: invalid,
      homeDir,
    });
    expect(proposal.problems.length).toBeGreaterThan(0);
    await expect(store.apply(proposal.id, homeDir)).rejects.toThrow(/invalid/i);
    expect(loadTeamDefinition('review-loop', projectDir, homeDir)).toBeNull();
  });

  it('detects a base-version conflict before write', async () => {
    await saveTeamDefinition(graph(), { projectDir, homeDir });
    const proposed = graph();
    proposed.description = 'Assistant revision';
    const store = new TeamProposalStore();
    const proposal = store.stage({
      assistantSessionId: 'assistant-1',
      projectPath: projectDir,
      definition: proposed,
      homeDir,
    });
    const external = graph();
    external.description = 'External revision';
    await saveTeamDefinition(external, { projectDir, homeDir, overwrite: true });

    await expect(store.apply(proposal.id, homeDir)).rejects.toBeInstanceOf(TeamProposalConflictError);
    expect(loadTeamDefinition('review-loop', projectDir, homeDir)?.definition.description)
      .toBe('External revision');
  });

  it('rejects overwriting built-in Teams', () => {
    const store = new TeamProposalStore();
    expect(() => store.stage({
      assistantSessionId: 'assistant-1',
      projectPath: projectDir,
      definition: graph('reviewer'),
      homeDir,
    })).toThrow(/built-in/i);
  });
});

describe('mergeTeamProposalLayout', () => {
  it('keeps stable node positions and unchanged manual edge endpoints', () => {
    const base = graph();
    const proposed = graph();
    proposed.nodes = proposed.nodes!.map(node => (
      node.id === 'reviewer'
        ? { ...node, model: 'model-c', ui: undefined }
        : { ...node, ui: undefined }
    ));
    proposed.nodes.splice(3, 0, { kind: 'agent', id: 'tester', model: 'model-d' });

    const merged = mergeTeamProposalLayout(base, proposed);
    expect(merged.nodes?.find(node => node.id === 'worker')?.ui).toMatchObject({ x: 80, y: 140 });
    expect(merged.nodes?.find(node => node.id === 'reviewer')?.ui).toMatchObject({ x: 300, y: 140 });
    expect(merged.nodes?.find(node => node.id === 'tester')?.ui?.x).toEqual(expect.any(Number));
    const loop = merged.edges?.find(edge => edge.loop);
    expect(loop?.ui).toEqual(base.edges?.find(edge => edge.loop)?.ui);
  });

  it('gives a new loop edge an outer semantic route', () => {
    const base = graph();
    const proposed = graph();
    proposed.edges = proposed.edges!.filter(edge => !edge.loop);
    proposed.edges.push({
      from: 'reviewer',
      to: 'worker',
      loop: true,
      condition: 'RETRY',
    });
    const merged = mergeTeamProposalLayout(base, proposed);
    const loop = merged.edges?.find(edge => edge.loop);
    expect(loop?.ui?.fromSide).toBe(loop?.ui?.toSide);
    const detour = Math.max(
      Math.abs(loop?.ui?.c1?.dx ?? 0),
      Math.abs(loop?.ui?.c1?.dy ?? 0),
    );
    expect(detour).toBeGreaterThan(80);
  });
});
