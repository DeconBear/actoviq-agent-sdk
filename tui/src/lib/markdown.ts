import chalk from 'chalk';

// ── Markdown renderer ───────────────────────────────────────────
// Rules are ordered: inline code first (to protect its contents),
// then bold+italic (three stars) before bold (two stars) to prevent
// partial consumption.

const INLINE_CODE_RE = /(`+)(.+?)\1/g;

function protectInlineCode(text: string): { result: string; placeholders: Map<string, string> } {
  const placeholders = new Map<string, string>();
  let idx = 0;
  const result = text.replace(INLINE_CODE_RE, (_match, _backticks, inner) => {
    const key = `\x00IC${idx}\x00`;
    idx += 1;
    placeholders.set(key, chalk.cyan(inner));
    return key;
  });
  return { result, placeholders };
}

function restoreInlineCode(text: string, placeholders: Map<string, string>): string {
  let result = text;
  for (const [key, value] of placeholders) {
    result = result.replace(key, value);
  }
  return result;
}

const RULES: Array<{ pattern: RegExp; render: (cap: RegExpMatchArray) => string }> = [
  // Headers
  { pattern: /^### (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  { pattern: /^## (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  { pattern: /^# (.+)$/gm, render: (m) => chalk.bold.underline(m[1]!) },
  // Bold + italic (must come before bold to avoid ** consuming ***)
  { pattern: /\*\*\*(.+?)\*\*\*/g, render: (m) => chalk.bold.italic(m[1]!) },
  // Bold
  { pattern: /\*\*(.+?)\*\*/g, render: (m) => chalk.bold(m[1]!) },
  // Italic
  { pattern: /\*(.+?)\*/g, render: (m) => chalk.italic(m[1]!) },
  // Links [text](url)
  { pattern: /\[(.+?)\]\((.+?)\)/g, render: (m) => chalk.blue.underline(`${m[1]} (${m[2]})`) },
  // Blockquotes
  { pattern: /^&gt; (.+)$/gm, render: (m) => chalk.dim(`  ${m[1]}`) },
];

export function renderMarkdown(text: string): string {
  // Protect inline code from being processed by other rules
  const { result: protected_, placeholders } = protectInlineCode(text);
  let result = protected_;
  for (const { pattern, render } of RULES) {
    result = result.replace(pattern, (...args) => {
      const match = args as unknown as RegExpMatchArray;
      return render(match);
    });
  }
  return restoreInlineCode(result, placeholders);
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

export function highlightCode(code: string, _language?: string): string {
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
