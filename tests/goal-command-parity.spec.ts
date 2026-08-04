import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectGoalApi } from '../src/goal/projectGoalApi.js';
import { interactiveCommandUsage } from '../src/ui/commandSurface.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Goal interactive surface parity', () => {
  it('returns the same project status contract used by slash-command surfaces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-command-'));
    roots.push(directory);
    const api = new ProjectGoalApi(directory);
    try {
      const session = { id: 'command-session', metadata: {} };
      await api.command(session, 'start verify command parity');
      await api.command(session, 'schedule scheduled 15 120');
      const status = await api.command(session, 'status');
      expect(status.message).toContain('verify command parity');
      expect(status.message).toContain('continuation scheduled');
      expect(status.message).toContain('claims none');
      expect(status.message).toContain('handoffs none');
      expect(interactiveCommandUsage('goal')).toBe('/goal [<objective>|status|run|pause|resume|clear]');
    } finally {
      await api.close();
    }
  });

  it('updates the objective of the session goal in place instead of starting a new one', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-goal-session-'));
    roots.push(directory);
    const api = new ProjectGoalApi(directory);
    try {
      const session = { id: 'session-a', metadata: {} };
      await api.command(session, 'ship the first cut');
      const created = await api.status(session.id);
      await api.command(session, 'ship the reviewed cut');
      const updated = await api.status(session.id);
      expect(updated.goalId).toBe(created.goalId);
      expect(updated.goal?.objective).toBe('ship the reviewed cut');
      expect(updated.goal?.createdAt).toBe(created.goal?.createdAt);

      const other = { id: 'session-b', metadata: {} };
      await api.command(other, 'a different chat goal');
      const separate = await api.status(other.id);
      expect(separate.goalId).not.toBe(created.goalId);
      expect((await api.status(session.id)).goal?.objective).toBe('ship the reviewed cut');
    } finally {
      await api.close();
    }
  });

  it('keeps TUI and GUI wired to the same ProjectGoalApi command method', async () => {
    const [tui, gui] = await Promise.all([
      readFile(path.resolve('src/tui/hadamardTui.ts'), 'utf8'),
      readFile(path.resolve('src/gui/hadamardGui.ts'), 'utf8'),
    ]);
    expect(tui).toContain('sdk.goals.command(session, args)');
    expect(gui).toContain('sdk.goals.command(session, args)');
    expect(gui).toContain('data-testid="session-goal-banner"');
    expect(gui).toContain("'/api/session-goal'");
    expect(gui).toContain('id="composerCommandChip"');
    expect(gui).toContain('function setComposerChip(chip)');
    expect(gui).toContain("setComposerChip({ kind: 'command', name: 'plan' })");
    expect(gui).not.toContain("setComposerCommand('/plan ')");
    expect(gui).toContain("setComposerChip({ kind: 'plugin'");
    expect(gui).toContain("setComposerChip({ kind: 'skill'");
    expect(gui).not.toContain('composerGoalMode');
    expect(gui).not.toContain('goalModeChip');
  });
});
