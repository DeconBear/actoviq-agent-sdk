import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_TEAM_PREFERENCES,
  readTeamPreferences,
  writeTeamPreferences,
} from '../src/team/teamPreferences.js';

describe('team preferences (plan §3.3 / Phase 0)', () => {
  it('defaults to manual mode: autoInvoke off, confirm on, no default team', () => {
    expect(DEFAULT_TEAM_PREFERENCES).toEqual({
      autoInvoke: false,
      defaultAttached: null,
      confirmBeforeRun: true,
    });
    expect(readTeamPreferences(undefined)).toEqual(DEFAULT_TEAM_PREFERENCES);
    expect(readTeamPreferences({})).toEqual(DEFAULT_TEAM_PREFERENCES);
    expect(readTeamPreferences({ preferences: { team: { autoInvoke: 'yes' } } })).toEqual(
      DEFAULT_TEAM_PREFERENCES,
    );
  });

  it('round-trips through writeTeamPreferences without dropping other prefs', () => {
    const raw: Record<string, unknown> = { preferences: { workMode: 'coding' } };
    writeTeamPreferences(raw, { autoInvoke: true, defaultAttached: 'quick-review', confirmBeforeRun: false });
    expect((raw.preferences as Record<string, unknown>).workMode).toBe('coding');
    expect(readTeamPreferences(raw)).toEqual({
      autoInvoke: true,
      defaultAttached: 'quick-review',
      confirmBeforeRun: false,
    });
  });

  it('gates the attached team tool on autoInvoke in every surface (Phase 0 acceptance)', () => {
    // When autoInvoke is off, an attached team must stay a selection only —
    // the main agent's tool list must NOT include the team tool. All three
    // surfaces implement this with the same guard expression.
    const root = join(import.meta.dirname, '..');
    for (const file of [
      join(root, 'src', 'cli', 'actoviq-react.ts'),
      join(root, 'src', 'tui', 'actoviqTui.ts'),
      join(root, 'src', 'gui', 'actoviqGui.ts'),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('activeTeamTool && teamPrefs.autoInvoke ?');
      // Every injection site of the team tool must carry the autoInvoke guard.
      const injections = source.match(/activeTeamTool[^\n]*tools:/g) ?? [];
      for (const site of injections) {
        expect(site, `${file}: ${site}`).toContain('teamPrefs.autoInvoke');
      }
    }
  });
});
