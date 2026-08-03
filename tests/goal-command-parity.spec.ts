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
      expect(interactiveCommandUsage('goal')).toContain('schedule <manual|foreground|scheduled>');
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
    expect(gui).toContain('data-testid="project-goal-status"');
  });
});
