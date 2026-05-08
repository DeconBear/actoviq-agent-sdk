import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { renderMarkdown, highlightCode, box } from '../src/lib/markdown.js';
import { formatTime, formatRelative, formatDuration, estimateTokens } from '../src/lib/formatters.js';
import { loadKeybindings, DEFAULT_BINDINGS, listBindings } from '../src/lib/keybindings.js';
import { getTheme, themes } from '../src/lib/theme.js';

// Force chalk to produce ANSI codes in all environments
beforeAll(() => {
  chalk.level = 3;
});

describe('markdown renderer', () => {
  it('renders bold text', () => {
    const result = renderMarkdown('hello **world**');
    expect(result).not.toBe('hello **world**'); // should contain ANSI
  });

  it('renders inline code', () => {
    const result = renderMarkdown('use `const` here');
    expect(result).not.toBe('use `const` here');
  });

  it('passes through plain text', () => {
    const result = renderMarkdown('hello world');
    expect(result).toBe('hello world');
  });
});

describe('syntax highlighting', () => {
  it('highlights keywords', () => {
    const result = highlightCode('const x = 1;');
    expect(result).not.toBe('const x = 1;');
  });

  it('highlights strings', () => {
    const result = highlightCode('let msg = "hello";');
    expect(result).not.toBe('let msg = "hello";');
  });
});

describe('box drawing', () => {
  it('draws a simple box', () => {
    const result = box('hi');
    expect(result).toContain('┌');
    expect(result).toContain('┐');
    expect(result).toContain('└');
    expect(result).toContain('┘');
    expect(result).toContain('hi');
  });

  it('draws a box with title', () => {
    const result = box('content', 'Title');
    expect(result).toContain('Title');
  });
});

describe('formatters', () => {
  it('formatTime returns HH:MM:SS', () => {
    const time = formatTime('2026-05-09T12:30:45.000Z');
    expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('formatRelative returns human-readable duration', () => {
    const now = new Date();
    const oneMinAgo = new Date(now.getTime() - 65000).toISOString();
    const result = formatRelative(oneMinAgo);
    expect(result).toContain('1m ago');
  });

  it('formatDuration formats ms', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65000)).toContain('1m');
  });

  it('estimateTokens gives rough count', () => {
    const tokens = estimateTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });
});

describe('keybindings', () => {
  it('loads default bindings when no config file', () => {
    const bindings = loadKeybindings('/nonexistent/path');
    expect(bindings.submit).toBe(DEFAULT_BINDINGS.submit);
    expect(bindings.abort).toBe(DEFAULT_BINDINGS.abort);
  });

  it('lists all bindings', () => {
    const list = listBindings(DEFAULT_BINDINGS);
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list.some(b => b.action === 'abort')).toBe(true);
    expect(list.some(b => b.action === 'toggleOverlay')).toBe(true);
  });
});

describe('theme', () => {
  it('has all built-in themes', () => {
    expect(themes.dark).toBeDefined();
    expect(themes.light).toBeDefined();
    expect(themes.nord).toBeDefined();
    expect(themes.monokai).toBeDefined();
  });

  it('getTheme returns default for unknown name', () => {
    const theme = getTheme('nonexistent');
    expect(theme.name).toBe('dark');
  });

  it('getTheme returns requested theme', () => {
    const theme = getTheme('nord');
    expect(theme.name).toBe('nord');
  });

  it('all themes have required color keys', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.colors.primary).toBeDefined();
      expect(theme.colors.error).toBeDefined();
      expect(theme.colors.text).toBeDefined();
      expect(theme.colors.border).toBeDefined();
    }
  });
});
