/**
 * Scrollback-friendly renderer for the Actoviq TUI, mirroring Claude Code's
 * default REPL model (Ink <Static> + dynamic bottom region) without React:
 *
 * - Transcript lines are printed permanently into the normal terminal
 *   scrollback (`appendStatic`).
 * - A bottom dynamic region (status line, prompt bar, menus, dialogs) is
 *   redrawn in place (`setDynamic`).
 *
 * The real terminal cursor stays hidden and parked at the top-left of the
 * dynamic region; the input caret is drawn as an inverse-video cell by the
 * caller. That single invariant keeps erase/redraw bookkeeping trivial.
 */
import { wrapToWidth } from './ansi.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_DOWN = '\x1b[0J';
const CLEAR_LINE_RIGHT = '\x1b[0K';
const SAVE_CURSOR = '\x1b[s';
const RESTORE_CURSOR = '\x1b[u';

export interface ScreenOutput {
  write(text: string): void;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export class TuiScreen {
  private dynamicLines: string[] = [];
  private dynamicVisualCount = 0;
  private started = false;
  private readonly resizeListener = () => this.redraw();

  constructor(private readonly out: ScreenOutput) {}

  get width(): number {
    return Math.max(this.out.columns ?? 80, 10);
  }

  get height(): number {
    return Math.max(this.out.rows ?? 24, 6);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.out.write(HIDE_CURSOR);
    this.out.on?.('resize', this.resizeListener);
  }

  /** Erase the dynamic region, restore the cursor, and detach listeners. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.out.off?.('resize', this.resizeListener);
    this.out.write(CLEAR_DOWN + SHOW_CURSOR);
    this.dynamicLines = [];
    this.dynamicVisualCount = 0;
  }

  /** Print lines permanently into scrollback above the dynamic region. */
  appendStatic(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const wrapped: string[] = [];
    for (const line of lines) {
      wrapped.push(...wrapToWidth(line, this.width));
    }
    this.out.write(
      CLEAR_DOWN +
        wrapped.join('\n') +
        '\n' +
        this.buildDynamicPaint(),
    );
  }

  /** Replace the dynamic bottom region. Lines are pre-wrapped to width. */
  setDynamic(lines: readonly string[]): void {
    const wrapped: string[] = [];
    for (const line of lines) {
      wrapped.push(...wrapToWidth(line, this.width));
    }
    // Keep the region within the viewport so cursor-up math stays valid.
    const maxRows = this.height - 1;
    const nextLines = wrapped.slice(0, maxRows);
    if (sameLines(this.dynamicLines, nextLines)) return;

    const previousLines = this.dynamicLines;
    this.dynamicLines = nextLines;
    if (previousLines.length === nextLines.length && nextLines.length > 0) {
      this.redrawChangedLines(previousLines);
    } else {
      this.redraw();
    }
  }

  private redraw(): void {
    this.out.write(CLEAR_DOWN + this.buildDynamicPaint());
  }

  private redrawChangedLines(previousLines: readonly string[]): void {
    let output = SAVE_CURSOR;
    for (let index = 0; index < this.dynamicLines.length; index += 1) {
      if (previousLines[index] === this.dynamicLines[index]) continue;
      output += RESTORE_CURSOR;
      if (index > 0) output += `\x1b[${index}B`;
      output += `\r${this.dynamicLines[index]}${CLEAR_LINE_RIGHT}`;
    }
    output += RESTORE_CURSOR;
    this.out.write(output);
  }

  private buildDynamicPaint(): string {
    if (this.dynamicLines.length === 0) {
      this.dynamicVisualCount = 0;
      return '';
    }
    this.dynamicVisualCount = this.dynamicLines.length;
    // Park the cursor back at the start of the region (column 1, top row).
    let output = this.dynamicLines.join('\n') + '\r';
    if (this.dynamicVisualCount > 1) {
      output += `\x1b[${this.dynamicVisualCount - 1}A`;
    }
    return output;
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
