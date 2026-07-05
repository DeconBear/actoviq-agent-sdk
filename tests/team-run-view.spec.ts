/**
 * Team Run tree view tests — shared formatting for GUI/TUI/REPL (Phase 5).
 */
import { describe, it, expect } from 'vitest';
import {
  applyTeamRunEvent,
  createTeamRunViewState,
  formatTeamRunTreeLines,
  teamRunViewFromSnapshot,
} from '../src/team/teamRunView.js';
import type { TeamEvent } from '../src/types.js';

describe('teamRunView', () => {
  it('formats a flat legacy panel roster when there are no edges', () => {
    let state = createTeamRunViewState('panel-analysis');
    applyTeamRunEvent(state, {
      type: 'team.started',
      mode: 'panel-analysis',
      members: [
        { id: 'researcher', model: 'm1', role: 'researcher' },
        { id: 'skeptic', model: 'm2', role: 'skeptic' },
      ],
    });
    applyTeamRunEvent(state, { type: 'team.member.started', id: 'researcher', model: 'm1', role: 'researcher', round: 1 });
    applyTeamRunEvent(state, { type: 'team.member.completed', id: 'researcher', model: 'm1', role: 'researcher', round: 1, ok: true, toolCalls: 3, durationMs: 4200 });
    applyTeamRunEvent(state, { type: 'team.member.started', id: 'skeptic', model: 'm2', role: 'skeptic', round: 1 });
    applyTeamRunEvent(state, { type: 'team.member.tool', id: 'skeptic', model: 'm2', round: 1, tool: 'Read' });

    const lines = formatTeamRunTreeLines(state);
    expect(lines[0]).toContain('Team run');
    expect(lines.some((l) => l.includes('✓ researcher') && l.includes('3 tools'))).toBe(true);
    expect(lines.some((l) => l.includes('● skeptic') && l.includes('Read'))).toBe(true);
  });

  it('nests graph children under fired edges', () => {
    let state = createTeamRunViewState('graph-pipeline');
    const events: TeamEvent[] = [
      { type: 'team.started', mode: 'graph', members: [{ id: 'a', model: 'm1' }, { id: 'b', model: 'm2' }] },
      { type: 'team.member.completed', id: 'a', model: 'm1', round: 1, ok: true, toolCalls: 1, durationMs: 1000 },
      { type: 'team.edge.triggered', from: 'a', to: 'b', trigger: 'on_complete', channel: 'message' },
      { type: 'team.member.started', id: 'b', model: 'm2', round: 1 },
    ];
    for (const event of events) applyTeamRunEvent(state, event);

    const lines = formatTeamRunTreeLines(state);
    const bLine = lines.find((l) => l.includes('b'));
    expect(bLine).toBeDefined();
    expect(bLine!.startsWith('  ')).toBe(true);
    expect(bLine).toContain('●');
  });

  it('shows error meta and incompleteReason', () => {
    let state = createTeamRunViewState('reviewer');
    applyTeamRunEvent(state, {
      type: 'team.started',
      mode: 'reviewer',
      members: [{ id: 'reviewer', model: 'm1', role: 'reviewer' }],
    });
    applyTeamRunEvent(state, {
      type: 'team.member.completed',
      id: 'reviewer',
      model: 'm1',
      role: 'reviewer',
      round: 1,
      ok: false,
      toolCalls: 0,
      durationMs: 500,
      error: 'timeout',
    });
    applyTeamRunEvent(state, { type: 'team.completed', mode: 'reviewer', rounds: 1, incompleteReason: '1 of 1 node run(s) failed' });

    const lines = formatTeamRunTreeLines(state);
    expect(lines.some((l) => l.includes('✗ reviewer') && l.includes('timeout'))).toBe(true);
    expect(lines.some((l) => l.includes('! 1 of 1 node run(s) failed'))).toBe(true);
  });

  it('builds view state from GUI run snapshots', () => {
    const view = teamRunViewFromSnapshot({
      label: 'team:reviewer',
      status: 'running',
      team: {
        mode: 'reviewer',
        members: [{ id: 'reviewer', status: 'running', currentTool: 'Grep' }],
        edges: [],
      },
    });
    const lines = formatTeamRunTreeLines(view);
    expect(lines.some((l) => l.includes('● reviewer') && l.includes('Grep'))).toBe(true);
  });

  it('returns no lines when there are no members', () => {
    expect(formatTeamRunTreeLines(createTeamRunViewState())).toEqual([]);
  });
});
