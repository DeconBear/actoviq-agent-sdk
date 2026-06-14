/**
 * Pure multi-line input editor state for the Actoviq TUI. No terminal I/O —
 * the app feeds key operations in and renders `visualLines()` out, which
 * keeps the editing logic unit-testable without a PTY.
 */
import { charDisplayWidth } from './ansi.js';

const WORD_BOUNDARY = /[\s/\\.,;:'"`(){}[\]<>|=+\-*&^%$#@!?~]/;

export interface EditorVisual {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

export class InputEditor {
  text = '';
  cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private readonly historyLimit: number;

  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 1000;
  }

  isEmpty(): boolean {
    return this.text.length === 0;
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
    this.historyIndex = -1;
  }

  setText(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  insert(value: string): void {
    if (!value) return;
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  private prevBoundary(index: number): number {
    if (index <= 0) return 0;
    const codePoint = this.text.codePointAt(index - 1);
    if (codePoint !== undefined && codePoint >= 0xdc00 && codePoint <= 0xdfff && index >= 2) {
      const full = this.text.codePointAt(index - 2);
      if (full !== undefined && full > 0xffff) return index - 2;
    }
    return index - 1;
  }

  private nextBoundary(index: number): number {
    if (index >= this.text.length) return this.text.length;
    const codePoint = this.text.codePointAt(index);
    return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const start = this.prevBoundary(this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  deleteForward(): void {
    if (this.cursor >= this.text.length) return;
    const end = this.nextBoundary(this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  moveLeft(): void {
    this.cursor = this.prevBoundary(this.cursor);
  }

  moveRight(): void {
    this.cursor = this.nextBoundary(this.cursor);
  }

  moveWordLeft(): void {
    let index = this.cursor;
    while (index > 0 && WORD_BOUNDARY.test(this.text[index - 1]!)) index -= 1;
    while (index > 0 && !WORD_BOUNDARY.test(this.text[index - 1]!)) index -= 1;
    this.cursor = index;
  }

  moveWordRight(): void {
    let index = this.cursor;
    while (index < this.text.length && WORD_BOUNDARY.test(this.text[index]!)) index += 1;
    while (index < this.text.length && !WORD_BOUNDARY.test(this.text[index]!)) index += 1;
    this.cursor = index;
  }

  /** unix-word-rubout: whitespace-delimited, matching readline's Ctrl+W. */
  deleteWordLeft(): void {
    const end = this.cursor;
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.text[index - 1]!)) index -= 1;
    while (index > 0 && !/\s/.test(this.text[index - 1]!)) index -= 1;
    this.cursor = index;
    this.text = this.text.slice(0, index) + this.text.slice(end);
  }

  killToEnd(): void {
    const lineEnd = this.findLineEnd();
    if (this.cursor === lineEnd && lineEnd < this.text.length) {
      // At line end: join with the next line (readline behavior).
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
      return;
    }
    this.text = this.text.slice(0, this.cursor) + this.text.slice(lineEnd);
  }

  killToStart(): void {
    const lineStart = this.findLineStart();
    this.text = this.text.slice(0, lineStart) + this.text.slice(this.cursor);
    this.cursor = lineStart;
  }

  private findLineStart(): number {
    const index = this.text.lastIndexOf('\n', this.cursor - 1);
    return index === -1 ? 0 : index + 1;
  }

  private findLineEnd(): number {
    const index = this.text.indexOf('\n', this.cursor);
    return index === -1 ? this.text.length : index;
  }

  moveHome(): void {
    this.cursor = this.findLineStart();
  }

  moveEnd(): void {
    this.cursor = this.findLineEnd();
  }

  /** True when the cursor sits on the first logical line. */
  onFirstLine(): boolean {
    return this.text.lastIndexOf('\n', this.cursor - 1) === -1;
  }

  /** True when the cursor sits on the last logical line. */
  onLastLine(): boolean {
    return this.text.indexOf('\n', this.cursor) === -1;
  }

  moveUp(): void {
    if (this.onFirstLine()) return;
    const lineStart = this.findLineStart();
    const column = this.cursor - lineStart;
    const prevLineStart =
      this.text.lastIndexOf('\n', lineStart - 2) === -1
        ? 0
        : this.text.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLineLength = lineStart - 1 - prevLineStart;
    this.cursor = prevLineStart + Math.min(column, prevLineLength);
  }

  moveDown(): void {
    if (this.onLastLine()) return;
    const lineStart = this.findLineStart();
    const column = this.cursor - lineStart;
    const lineEnd = this.findLineEnd();
    const nextLineStart = lineEnd + 1;
    const nextLineEnd = this.text.indexOf('\n', nextLineStart);
    const nextLineLength = (nextLineEnd === -1 ? this.text.length : nextLineEnd) - nextLineStart;
    this.cursor = nextLineStart + Math.min(column, nextLineLength);
  }

  /**
   * Submit semantics: a trailing backslash on the current line turns Enter
   * into a newline (Claude Code's `\↵`); otherwise the text is committed to
   * history and the editor resets. Returns null when Enter became a newline.
   */
  submit(): string | null {
    const lineStart = this.findLineStart();
    const line = this.text.slice(lineStart, this.findLineEnd());
    if (line.endsWith('\\') && this.cursor === this.findLineEnd()) {
      this.text = `${this.text.slice(0, this.cursor - 1)}\n${this.text.slice(this.cursor)}`;
      return null;
    }
    const value = this.text;
    if (value.trim().length > 0) {
      if (this.history.at(-1) !== value) {
        this.history.push(value);
        if (this.history.length > this.historyLimit) this.history.shift();
      }
    }
    this.clear();
    return value;
  }

  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return true;
    }
    this.setText(this.history[this.historyIndex] ?? '');
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.setText(this.history[this.historyIndex] ?? '');
    } else {
      this.historyIndex = -1;
      this.setText(this.draft);
    }
    return true;
  }

  /**
   * Wrap the buffer into visual lines of `width` columns and locate the
   * cursor in that grid. Wide characters occupy two columns.
   */
  visualLines(width: number): EditorVisual {
    const safeWidth = Math.max(width, 4);
    const lines: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let consumed = 0;

    for (const logical of this.text.split('\n')) {
      let current = '';
      let currentWidth = 0;
      const logicalStart = consumed;
      for (const char of logical) {
        const charWidth = charDisplayWidth(char.codePointAt(0) ?? 0);
        if (currentWidth + charWidth > safeWidth) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }
        if (consumed === this.cursor) {
          cursorRow = lines.length;
          cursorCol = currentWidth;
        }
        current += char;
        currentWidth += charWidth;
        consumed += char.length;
      }
      if (this.cursor === consumed && this.cursor >= logicalStart) {
        if (currentWidth >= safeWidth) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }
        cursorRow = lines.length;
        cursorCol = currentWidth;
      }
      lines.push(current);
      consumed += 1; // the '\n'
    }

    return { lines, cursorRow, cursorCol };
  }
}
