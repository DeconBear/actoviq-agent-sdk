/**
 * Team preferences — the `preferences.team` block of `~/.actoviq/settings.json`.
 *
 * Shared by GUI / TUI / REPL so the three surfaces read and write the same
 * policy switches:
 *
 *   - `autoInvoke`      — when a team is attached, whether the main agent gets
 *                         the team registered as a callable tool (default off:
 *                         attach is a selection, `/team ask` stays manual).
 *   - `defaultAttached` — team name to auto-attach for new conversations. If
 *                         the name cannot be resolved it is silently ignored
 *                         (surfaces should hint via `/team status`).
 *   - `confirmBeforeRun`— interactive surfaces ask before `/team ask` runs
 *                         (member count + models). Non-interactive/headless
 *                         paths must skip the confirmation.
 */
import { isRecord } from '../runtime/helpers.js';

export interface TeamPreferences {
  autoInvoke: boolean;
  defaultAttached: string | null;
  confirmBeforeRun: boolean;
}

export const DEFAULT_TEAM_PREFERENCES: TeamPreferences = {
  autoInvoke: false,
  defaultAttached: null,
  confirmBeforeRun: true,
};

/** Read `preferences.team` from a settings raw object (tolerates absence). */
export function readTeamPreferences(raw: Record<string, unknown> | undefined | null): TeamPreferences {
  const preferences = isRecord(raw?.preferences) ? raw.preferences : {};
  const team = isRecord(preferences.team) ? preferences.team : {};
  return {
    autoInvoke: typeof team.autoInvoke === 'boolean' ? team.autoInvoke : DEFAULT_TEAM_PREFERENCES.autoInvoke,
    defaultAttached:
      typeof team.defaultAttached === 'string' && team.defaultAttached.trim()
        ? team.defaultAttached.trim()
        : DEFAULT_TEAM_PREFERENCES.defaultAttached,
    confirmBeforeRun:
      typeof team.confirmBeforeRun === 'boolean' ? team.confirmBeforeRun : DEFAULT_TEAM_PREFERENCES.confirmBeforeRun,
  };
}

/** Write `preferences.team` into a settings raw object (mutates and returns it). */
export function writeTeamPreferences(
  raw: Record<string, unknown>,
  prefs: TeamPreferences,
): Record<string, unknown> {
  const preferences = isRecord(raw.preferences) ? raw.preferences : {};
  raw.preferences = {
    ...preferences,
    team: {
      autoInvoke: prefs.autoInvoke,
      defaultAttached: prefs.defaultAttached,
      confirmBeforeRun: prefs.confirmBeforeRun,
    },
  };
  return raw;
}
