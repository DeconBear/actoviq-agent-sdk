/**
 * Dependency-free ANSI helpers for the Actoviq TUI: styling, display-width
 * measurement (East Asian wide characters count as 2 columns), truncation,
 * and width-aware wrapping that treats escape sequences as zero-width.
 */

export const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Display width of one code point: 0 for combining marks, 2 for wide chars. */
export function charDisplayWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks render at zero width.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  // East Asian Wide / Fullwidth ranges (simplified wcwidth).
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals .. Yi
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // Emoji
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string, ignoring ANSI escapes. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charDisplayWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** Truncate to a display width, appending an ellipsis when content is cut. */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  const ellipsisWidth = stringWidth(ellipsis);
  const budget = Math.max(maxWidth - ellipsisWidth, 0);
  let width = 0;
  let result = '';
  for (const char of stripAnsi(text)) {
    const charWidth = charDisplayWidth(char.codePointAt(0) ?? 0);
    if (width + charWidth > budget) break;
    width += charWidth;
    result += char;
  }
  return result + ellipsis;
}

/**
 * Wrap text to a display width. ANSI escapes are carried along as zero-width
 * and styling is reset at each line end / restored at the next line start so
 * a styled span can safely cross wrap boundaries.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const logical of text.split('\n')) {
    if (logical.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    let activeStyles: string[] = [];
    let index = 0;
    while (index < logical.length) {
      ANSI_PATTERN.lastIndex = index;
      const match = ANSI_PATTERN.exec(logical);
      if (match && match.index === index) {
        current += match[0];
        if (match[0] === A.reset) {
          activeStyles = [];
        } else if (/\x1b\[[0-9;]*m/.test(match[0])) {
          activeStyles.push(match[0]);
        }
        index += match[0].length;
        continue;
      }
      const codePoint = logical.codePointAt(index)!;
      const char = String.fromCodePoint(codePoint);
      const charWidth = charDisplayWidth(codePoint);
      if (currentWidth + charWidth > width) {
        lines.push(current + (activeStyles.length > 0 ? A.reset : ''));
        current = activeStyles.join('');
        currentWidth = 0;
      }
      current += char;
      currentWidth += charWidth;
      index += char.length;
    }
    lines.push(current + (activeStyles.length > 0 ? A.reset : ''));
  }
  return lines;
}
