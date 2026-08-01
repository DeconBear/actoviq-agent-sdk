import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
} from '../src/ui/commandSurface.js';

const root = new URL('../', import.meta.url);

function commandCase(
  source: string,
  marker: string,
  indent: string,
  command: string,
): string {
  const handlerStart = source.indexOf(marker);
  expect(handlerStart, `${marker} exists`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(handlerStart).split(/\r?\n/u);
  const start = lines.findIndex(line => line.startsWith(`${indent}case '${command}'`));
  expect(start, `/${command} case exists`).toBeGreaterThanOrEqual(0);
  const next = lines.slice(start + 1).findIndex(line =>
    line.startsWith(`${indent}case '`) || line.startsWith(`${indent}default:`));
  return lines.slice(start, next === -1 ? undefined : start + 1 + next).join('\n');
}

describe('interactive CLI convergence', () => {
  it('publishes hadamard-tui as the only terminal agent entry point', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(pkg.bin['hadamard-tui']).toBe('./bin/hadamard-tui.js');
    expect(pkg.bin).not.toHaveProperty('hadamard-react');
    expect(pkg.bin).not.toHaveProperty('hadamard-interactive-agent');
    await expect(access(new URL('src/cli/hadamard-react.ts', root))).rejects.toThrow();
    await expect(access(new URL('src/cli/bridge-interactive-agent.ts', root))).rejects.toThrow();
    await expect(access(new URL('bin/hadamard-react.js', root))).rejects.toThrow();
    await expect(access(new URL('bin/hadamard-interactive-agent.js', root))).rejects.toThrow();
  });

  it('keeps every shared top-level and second-level command wired in TUI and GUI', async () => {
    const [tui, gui] = await Promise.all([
      readFile(new URL('src/tui/hadamardTui.ts', root), 'utf8'),
      readFile(new URL('src/gui/hadamardGui.ts', root), 'utf8'),
    ]);

    const tuiCases = new Map(Object.keys(HADAMARD_INTERACTIVE_COMMANDS).map(command => [
      command,
      commandCase(tui, 'async function runSlashCommand(raw: string)', '        ', command),
    ]));
    const guiCases = new Map(Object.keys(HADAMARD_INTERACTIVE_COMMANDS).map(command => [
      command,
      commandCase(gui, 'async function runSlashCommand(raw: string)', '      ', command),
    ]));
    const browserRouted = new Map([
      ['issues:start', "input.match(/^\\/issues\\s+start"],
      ['manager:chat', `input.startsWith('/manager chat ')`],
      ['manager:update', `input.startsWith('/manager update ')`],
      ['manager:team', `input.startsWith('/manager team ')`],
      ['assistant:chat', `input.startsWith('/assistant chat ')`],
      ['assistant:team', `input.startsWith('/assistant team ')`],
    ]);
    for (const [command, subcommands] of Object.entries(SUBCOMMANDS)) {
      const tuiCase = tuiCases.get(command)!;
      const guiCase = guiCases.get(command)!;
      if (command === 'plugin' || command === 'rules') {
        expect(tuiCase, `TUI /${command} delegates its argument`).toContain(".execute(args || 'list')");
        expect(guiCase, `GUI /${command} delegates its argument`).toContain(".execute(args || 'list')");
        continue;
      }
      if (command === 'memory') {
        expect(tuiCase).toContain('/^(proposals|apply|reject)\\b/u.test(args)');
        expect(guiCase).toContain('/^(proposals|apply|reject)\\b/u.test(args)');
        continue;
      }
      if (command === 'dream') {
        expect(tuiCase).toContain('runDreamCommand(args.toLowerCase())');
        expect(tui).toContain("if (action === 'status')");
        expect(tui).toContain("if (action !== 'run')");
      }
      if (command === 'permissions') {
        expect(guiCase).toContain('setPermissionPreset(args.toLowerCase()');
        expect(gui).toContain("'read-only': {");
        expect(gui).toContain("workspace: { mode: 'acceptEdits'");
        expect(gui).toContain("full: { mode: 'bypassPermissions'");
      }
      for (const subcommand of subcommands) {
        const token = new RegExp(`(?:['"]${subcommand}(?:\\s|['"])|\\b${subcommand}\\s*:)`, 'u');
        if (command !== 'dream') {
          expect(tuiCase, `TUI /${command} ${subcommand}`).toMatch(token);
        }
        const browserRoute = browserRouted.get(`${command}:${subcommand}`);
        if (browserRoute) {
          expect(gui, `GUI /${command} ${subcommand} is routed by the browser command dispatcher`)
            .toContain(browserRoute);
        } else if (command !== 'permissions') {
          expect(guiCase, `GUI /${command} ${subcommand}`).toMatch(token);
        }
      }
    }
  });
});
