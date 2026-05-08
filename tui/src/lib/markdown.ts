import chalk from 'chalk';

// ── Markdown renderer ───────────────────────────────────────────

const RULES: Array<{ pattern: RegExp; render: (cap: RegExpMatchArray) => string }> = [
  // Headers
  { pattern: /^### (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  { pattern: /^## (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  { pattern: /^# (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  // Bold + italic
  { pattern: /\*\*\*(.+?)\*\*\*/g, render: (m) => chalk.bold.italic(m[1]!) },
  // Bold
  { pattern: /\*\*(.+?)\*\*/g, render: (m) => chalk.bold(m[1]!) },
  // Italic
  { pattern: /\*(.+?)\*/g, render: (m) => chalk.italic(m[1]!) },
  // Inline code
  { pattern: /`(.+?)`/g, render: (m) => chalk.cyan(m[1]!) },
  // Links [text](url)
  { pattern: /\[(.+?)\]\((.+?)\)/g, render: (m) => chalk.blue.underline(`${m[1]} (${m[2]})`) },
  // Blockquotes
  { pattern: /^&gt; (.+)$/gm, render: (m) => chalk.dim(`  ${m[1]}`) },
];

export function renderMarkdown(text: string): string {
  let result = text;
  for (const { pattern, render } of RULES) {
    result = result.replace(pattern, (...args) => {
      const match = args as unknown as RegExpMatchArray;
      // Preserve arg types for regex replace callback
      return render(match);
    });
  }
  return result;
}

// ── Syntax highlight ────────────────────────────────────────────

const TOKEN_PATTERNS: Array<{ pattern: RegExp; color: (s: string) => string }> = [
  { pattern: /\b(const|let|var|function|return|if|else|for|while|class|export|import|from|async|await|try|catch|throw|new|typeof|instanceof|interface|type|enum)\b/g, color: chalk.magenta },
  { pattern: /\b(true|false|null|undefined)\b/g, color: chalk.yellow },
  { pattern: /\b(\d+\.?\d*)\b/g, color: chalk.yellow },
  { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, color: chalk.green },
  { pattern: /(\/\/.*$)/gm, color: chalk.dim },
  { pattern: /(\b[A-Z_][A-Z0-9_]+\b)/g, color: chalk.blue },
];

export function highlightCode(code: string, language?: string): string {
  // For now, generic JS/TS-like highlighting
  let result = code;
  for (const { pattern, color } of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match) => color(match));
  }
  return result;
}

// ── Box drawing ─────────────────────────────────────────────────

export function box(text: string, title?: string): string {
  const lines = text.split('\n');
  const width = Math.max(...lines.map((l) => stripAnsi(l).length), title ? title.length + 4 : 0);
  const top = title
    ? `┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 3))}┐`
    : `┌${'─'.repeat(width + 2)}┐`;
  const bottom = `└${'─'.repeat(width + 2)}┘`;
  const body = lines.map((l) => {
    const stripped = stripAnsi(l);
    const pad = width - stripped.length;
    return `│ ${l}${' '.repeat(Math.max(0, pad))} │`;
  }).join('\n');
  return `${top}\n${body}\n${bottom}`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
