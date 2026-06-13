import { describe, expect, it } from 'vitest';

import { stringWidth, stripAnsi, truncateToWidth, wrapToWidth, A } from '../src/tui/ansi.js';
import { InputEditor } from '../src/tui/editor.js';
import { TuiScreen, type ScreenOutput } from '../src/tui/screen.js';
import {
  StreamFlusher,
  formatToolCall,
  formatToolResult,
  summarizeToolInput,
} from '../src/tui/transcript.js';
import { filterSlashCommands } from '../src/tui/actoviqTui.js';

describe('ansi helpers', () => {
  it('measures display width with CJK and ANSI codes', () => {
    expect(stringWidth('abc')).toBe(3);
    expect(stringWidth('中文')).toBe(4);
    expect(stringWidth(`${A.bold}hi${A.reset}`)).toBe(2);
  });

  it('truncates to display width with an ellipsis', () => {
    expect(truncateToWidth('hello world', 7)).toBe('hello …');
    expect(truncateToWidth('中文字符串', 5)).toBe('中文…');
    expect(truncateToWidth('short', 10)).toBe('short');
  });

  it('wraps text at display width, keeping CJK pairs intact', () => {
    expect(wrapToWidth('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapToWidth('中文字', 4)).toEqual(['中文', '字']);
    expect(wrapToWidth('a\nb', 10)).toEqual(['a', 'b']);
  });

  it('restores styling across wrapped lines', () => {
    const wrapped = wrapToWidth(`${A.dim}abcdef${A.reset}`, 3);
    expect(wrapped).toHaveLength(2);
    expect(stripAnsi(wrapped[0]!)).toBe('abc');
    expect(wrapped[1]!.startsWith(A.dim)).toBe(true);
  });
});

describe('InputEditor', () => {
  it('inserts, moves, and deletes around the cursor', () => {
    const editor = new InputEditor();
    editor.insert('hello');
    editor.moveLeft();
    editor.moveLeft();
    editor.insert('X');
    expect(editor.text).toBe('helXlo');
    editor.backspace();
    expect(editor.text).toBe('hello');
    editor.moveHome();
    editor.deleteForward();
    expect(editor.text).toBe('ello');
  });

  it('handles word movement and word deletion', () => {
    const editor = new InputEditor();
    editor.insert('git commit -m message');
    editor.moveWordLeft();
    expect(editor.text.slice(0, editor.cursor)).toBe('git commit -m ');
    editor.deleteWordLeft();
    expect(editor.text).toBe('git commit message');
  });

  it('turns Enter into a newline after a trailing backslash', () => {
    const editor = new InputEditor();
    editor.insert('first line\\');
    expect(editor.submit()).toBeNull();
    expect(editor.text).toBe('first line\n');
    editor.insert('second');
    expect(editor.submit()).toBe('first line\nsecond');
    expect(editor.text).toBe('');
  });

  it('navigates multi-line text vertically', () => {
    const editor = new InputEditor();
    editor.insert('alpha\nbeta\ngamma');
    editor.moveUp();
    expect(editor.onLastLine()).toBe(false);
    editor.moveUp();
    expect(editor.onFirstLine()).toBe(true);
    editor.moveDown();
    editor.moveEnd();
    expect(editor.text.slice(0, editor.cursor).endsWith('beta')).toBe(true);
  });

  it('walks history with a preserved draft', () => {
    const editor = new InputEditor();
    editor.insert('one');
    editor.submit();
    editor.insert('two');
    editor.submit();
    editor.insert('draft');
    editor.historyPrev();
    expect(editor.text).toBe('two');
    editor.historyPrev();
    expect(editor.text).toBe('one');
    editor.historyNext();
    expect(editor.text).toBe('two');
    editor.historyNext();
    expect(editor.text).toBe('draft');
  });

  it('lays out visual lines and the caret with wide characters', () => {
    const editor = new InputEditor();
    editor.insert('中文ab');
    editor.moveLeft();
    const visual = editor.visualLines(10);
    expect(visual.lines).toEqual(['中文ab']);
    expect(visual.cursorRow).toBe(0);
    expect(visual.cursorCol).toBe(5); // 中(2)+文(2)+a(1)
  });

  it('wraps long input into multiple visual rows', () => {
    const editor = new InputEditor();
    editor.insert('abcdefghij');
    const visual = editor.visualLines(4);
    expect(visual.lines).toEqual(['abcd', 'efgh', 'ij']);
    expect(visual.cursorRow).toBe(2);
    expect(visual.cursorCol).toBe(2);
  });
});

class FakeOutput implements ScreenOutput {
  chunks: string[] = [];
  columns = 40;
  rows = 12;
  write(text: string): void {
    this.chunks.push(text);
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  get output(): string {
    return this.chunks.join('');
  }
}

describe('TuiScreen', () => {
  it('prints static lines and repaints the dynamic region below them', () => {
    const out = new FakeOutput();
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['[input]']);
    out.chunks = [];
    screen.appendStatic(['hello world']);
    expect(out.chunks).toHaveLength(1);
    expect(out.output).toContain('hello world\n');
    // Dynamic content painted after the static line.
    expect(out.output.lastIndexOf('[input]')).toBeGreaterThan(out.output.lastIndexOf('hello world'));
    screen.stop();
    expect(out.output).toContain('\x1b[?25h'); // cursor restored
  });

  it('moves the cursor back to the region start after painting', () => {
    const out = new FakeOutput();
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['line one', 'line two', 'line three']);
    expect(out.output).toContain('\x1b[2A'); // parked back up two lines
    screen.stop();
  });

  it('wraps overlong dynamic lines to the terminal width', () => {
    const out = new FakeOutput();
    out.columns = 10;
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['abcdefghijklmnop']);
    expect(out.output).toContain('abcdefghij\nklmnop');
    screen.stop();
  });

  it('does not repaint an unchanged dynamic region', () => {
    const out = new FakeOutput();
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['status', 'prompt']);
    const chunkCount = out.chunks.length;
    screen.setDynamic(['status', 'prompt']);
    expect(out.chunks).toHaveLength(chunkCount);
    screen.stop();
  });

  it('updates changed rows without clearing the full dynamic region', () => {
    const out = new FakeOutput();
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['working 1s', 'prompt']);
    out.chunks = [];

    screen.setDynamic(['working 2s', 'prompt']);

    expect(out.output).toContain('working 2s');
    expect(out.output).not.toContain('\x1b[0J');
    expect(out.output).not.toContain('prompt');
    expect(out.output).toContain('\x1b[s');
    expect(out.output).toContain('\x1b[u');
    screen.stop();
  });

  it('clears and repaints when the dynamic region changes height', () => {
    const out = new FakeOutput();
    const screen = new TuiScreen(out);
    screen.start();
    screen.setDynamic(['status', 'prompt']);
    out.chunks = [];

    screen.setDynamic(['prompt']);

    expect(out.output).toContain('\x1b[0J');
    expect(out.output).toContain('prompt');
    screen.stop();
  });
});

describe('transcript formatting', () => {
  it('summarizes tool input by its most meaningful field', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeToolInput('Read', { file_path: '/tmp/a.txt' })).toBe('/tmp/a.txt');
    expect(summarizeToolInput('TodoWrite', { todos: [1, 2, 3] })).toBe('3 items');
    expect(summarizeToolInput('X', {})).toBe('');
  });

  it('renders tool call and result lines', () => {
    const call = formatToolCall('Bash', { command: 'echo hi' }, 80);
    expect(stripAnsi(call[0]!)).toContain('⏺ Bash(echo hi)');
    const ok = formatToolResult({ isError: false, durationMs: 1500, outputText: 'done' }, 80);
    expect(stripAnsi(ok[0]!)).toContain('✓');
    expect(stripAnsi(ok[0]!)).toContain('1.5s');
    const err = formatToolResult({ isError: true, outputText: 'boom' }, 80);
    expect(stripAnsi(err[0]!)).toContain('✗');
  });
});

describe('StreamFlusher', () => {
  it('flushes complete lines and keeps the partial tail live', () => {
    const flusher = new StreamFlusher(() => 80);
    expect(flusher.push('Hello wo')).toEqual([]);
    expect(flusher.tail()).toBe('Hello wo');
    expect(flusher.push('rld\nNext li')).toEqual(['Hello world']);
    expect(flusher.tail()).toBe('Next li');
    expect(flusher.drain()).toEqual(['Next li']);
    expect(flusher.tail()).toBe('');
  });

  it('force-flushes an overlong unbroken tail', () => {
    const flusher = new StreamFlusher(() => 10);
    const flushed = flusher.push('x'.repeat(45));
    expect(flushed.length).toBeGreaterThan(0);
    expect(flusher.tail().length).toBeLessThanOrEqual(30);
  });
});

describe('slash command filtering', () => {
  it('matches prefixes and full names', () => {
    expect(filterSlashCommands('/')).toContain('help');
    expect(filterSlashCommands('/co')).toEqual(['compact']);
    expect(filterSlashCommands('/help')).toEqual(['help']);
    expect(filterSlashCommands('plain text')).toEqual([]);
    expect(filterSlashCommands('/unknown')).toEqual([]);
  });
});
