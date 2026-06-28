import { describe, expect, it } from 'vitest';

import { quoteForWindowsShell } from '../src/parity/bridgeExecResolver.js';

describe('quoteForWindowsShell', () => {
  it('leaves safe single-token args untouched (no quoting)', () => {
    expect(quoteForWindowsShell('-p')).toBe('-p');
    expect(quoteForWindowsShell('--output-format')).toBe('--output-format');
    expect(quoteForWindowsShell('stream-json')).toBe('stream-json');
    expect(quoteForWindowsShell('a/b/c.js')).toBe('a/b/c.js');
    expect(quoteForWindowsShell('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('wraps args containing spaces in double quotes', () => {
    // The core regression: a multi-word prompt must arrive as ONE token at
    // cmd.exe, not be split on spaces.
    expect(quoteForWindowsShell('My favorite number is 4242.')).toBe(
      '"My favorite number is 4242."',
    );
  });

  it('quotes an empty arg as ""', () => {
    expect(quoteForWindowsShell('')).toBe('""');
  });

  it('escapes internal double quotes and backslashes', () => {
    expect(quoteForWindowsShell('say "hi"')).toBe('"say \\"hi\\""');
    // A trailing backslash must be doubled so it cannot escape the closing quote.
    expect(quoteForWindowsShell('path\\')).toBe('"path\\\\"');
  });
});
