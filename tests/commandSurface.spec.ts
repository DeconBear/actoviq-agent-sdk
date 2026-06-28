import { describe, expect, it } from 'vitest';

import {
  ACTOVIQ_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
  filterInteractiveCommands,
} from '../src/ui/commandSurface.js';

describe('filterInteractiveCommands', () => {
  it('returns nothing without a leading slash', () => {
    expect(filterInteractiveCommands('hello')).toEqual([]);
    expect(filterInteractiveCommands('bridge run')).toEqual([]);
  });

  it('completes top-level command names while the user is still typing the head', () => {
    expect(filterInteractiveCommands('/bri')).toEqual(['bridge']);
    expect(filterInteractiveCommands('/bridge')).toEqual(['bridge']);
    // Every registered command is completable from its first letter.
    for (const name of Object.keys(ACTOVIQ_INTERACTIVE_COMMANDS)) {
      expect(filterInteractiveCommands(`/${name[0]}`)).toContain(name);
    }
  });

  it('offers sub-commands once a known parent is committed', () => {
    expect(filterInteractiveCommands('/bridge ')).toEqual([
      'bridge run',
      'bridge switch',
      'bridge model',
      'bridge config',
      'bridge setup',
      'bridge off',
      'bridge help',
    ]);
    expect(filterInteractiveCommands('/model ')).toEqual(['model router', 'model config']);
    expect(filterInteractiveCommands('/team ')).toEqual(['team ask', 'team list']);
  });

  it('filters sub-commands by prefix', () => {
    expect(filterInteractiveCommands('/bridge r')).toEqual(['bridge run']);
    // A fully-typed sub-command (no second space yet) still offers itself,
    // so Tab can commit it.
    expect(filterInteractiveCommands('/bridge run')).toEqual(['bridge run']);
  });

  it('closes the menu once a second space appears (sub committed, typing the argument)', () => {
    expect(filterInteractiveCommands('/bridge run ')).toEqual([]);
    expect(filterInteractiveCommands('/bridge run hello')).toEqual([]);
  });

  it('returns nothing for an unmatched sub-prefix', () => {
    expect(filterInteractiveCommands('/bridge runx')).toEqual([]);
  });

  it('returns nothing for a parent that has no sub-commands', () => {
    expect(filterInteractiveCommands('/clear ')).toEqual([]);
  });

  it('returns nothing for an unknown parent after a space', () => {
    expect(filterInteractiveCommands('/foo ')).toEqual([]);
  });

  it('SUBCOMMANDS only references registered top-level commands', () => {
    for (const head of Object.keys(SUBCOMMANDS)) {
      expect(ACTOVIQ_INTERACTIVE_COMMANDS[head]).toBeDefined();
    }
  });
});
