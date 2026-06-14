/**
 * Pure transcript-line formatters for the Actoviq TUI. These return styled
 * strings (not yet wrapped); the screen layer wraps them to the terminal
 * width before printing into scrollback.
 */
import { A, truncateToWidth } from './ansi.js';

/** Pick the most human-meaningful field of a tool input for the ⏺ line. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return '';
  }
  const record = input as Record<string, unknown>;
  const preferredKeys = [
    'command',
    'file_path',
    'notebook_path',
    'pattern',
    'path',
    'url',
    'skill',
    'description',
    'prompt',
    'query',
    'todos',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.replace(/\s+/g, ' ').trim();
    }
    if (key === 'todos' && Array.isArray(value)) {
      return `${value.length} item${value.length === 1 ? '' : 's'}`;
    }
  }
  try {
    const json = JSON.stringify(record);
    return json === '{}' ? '' : json;
  } catch {
    return '';
  }
}

export function formatUserPrompt(text: string): string[] {
  const lines = text.split('\n');
  return lines.map((line, index) => `${A.gray}${index === 0 ? '>' : ' '}${A.reset} ${A.bold}${line}${A.reset}`);
}

export function formatQueuedPrompt(text: string): string[] {
  return [`${A.gray}⧗ queued:${A.reset} ${A.dim}${text.replace(/\s+/g, ' ')}${A.reset}`];
}

export function formatToolCall(name: string, input: unknown, width: number): string[] {
  const summary = summarizeToolInput(name, input);
  const head = `${A.green}⏺${A.reset} ${A.bold}${name}${A.reset}`;
  if (!summary) return [head];
  return [`${head}${A.dim}(${truncateToWidth(summary, Math.max(width - name.length - 6, 16))})${A.reset}`];
}

export function formatToolResult(
  result: { isError: boolean; durationMs?: number; outputText?: string },
  width: number,
): string[] {
  const mark = result.isError ? `${A.red}✗` : `${A.green}✓`;
  const duration =
    typeof result.durationMs === 'number'
      ? result.durationMs < 1000
        ? `${result.durationMs}ms`
        : `${(result.durationMs / 1000).toFixed(1)}s`
      : '';
  const output = (result.outputText ?? '').replace(/\s+/g, ' ').trim();
  const meta = [duration, output].filter(Boolean).join(' · ');
  const budget = Math.max(width - 6, 16);
  return [`  ${A.gray}⎿${A.reset} ${mark}${A.reset} ${A.dim}${truncateToWidth(meta, budget)}${A.reset}`];
}

export function formatThinking(text: string, width: number): string[] {
  const condensed = text.replace(/\s+/g, ' ').trim();
  if (!condensed) return [];
  return [`${A.dim}∴ ${truncateToWidth(condensed, Math.max(width - 4, 16))}${A.reset}`];
}

export function formatCompactNotice(
  trigger: 'auto' | 'reactive' | string,
  tokenEstimateBefore?: number,
  tokenEstimateAfter?: number,
): string[] {
  const detail =
    typeof tokenEstimateBefore === 'number' && typeof tokenEstimateAfter === 'number'
      ? ` (~${Math.round(tokenEstimateBefore / 1000)}k → ~${Math.round(tokenEstimateAfter / 1000)}k tokens)`
      : '';
  return [`${A.magenta}∿ context compacted${A.reset}${A.dim} · ${trigger}${detail}${A.reset}`];
}

export function formatErrorLine(message: string): string[] {
  return [`${A.red}✗ ${message}${A.reset}`];
}

export function formatInfoLine(message: string): string[] {
  return [`${A.dim}${message}${A.reset}`];
}

export function formatDivider(width: number): string[] {
  return [`${A.gray}${'─'.repeat(Math.max(Math.min(width, 80), 8))}${A.reset}`];
}

export function formatBanner(options: {
  workDir: string;
  model: string;
  toolCount: number;
  permissionMode: string;
  version?: string;
  width?: number;
}): string[] {
  const width = Math.max(options.width ?? 80, 20);
  const title = `Hadamard Agent${options.version ? ` v${options.version}` : ''}`;
  const workDir = truncateToWidth(options.workDir, Math.max(width - 10, 20));
  return [
    `${A.cyan}${A.bold}✻ ${title}${A.reset}`,
    `${A.dim}  cwd    ${A.reset}${workDir}`,
    `${A.dim}  model  ${A.reset}${options.model} ${A.dim}· permissions: ${options.permissionMode}${A.reset}`,
    `${A.dim}  tools  ${A.reset}${options.toolCount} loaded`,
    '',
  ];
}

/**
 * Incremental flusher for streamed assistant text: complete visual lines move
 * into scrollback while the trailing partial line stays in the dynamic
 * region, giving flicker-free streaming with native scrollback.
 */
export class StreamFlusher {
  private buffer = '';

  constructor(private readonly width: () => number) {}

  get hasContent(): boolean {
    return this.buffer.length > 0;
  }

  /** Feed a delta; returns full logical lines ready for scrollback. */
  push(delta: string): string[] {
    this.buffer += delta;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const flushed: string[] = [];
    for (const line of lines) {
      flushed.push(line);
    }
    // Overlong trailing line: flush all but the final partial visual row so
    // the dynamic region stays one line tall.
    const width = Math.max(this.width(), 8);
    while (this.buffer.length > 3 * width) {
      flushed.push(this.buffer.slice(0, width));
      this.buffer = this.buffer.slice(width);
    }
    return flushed;
  }

  /** The partial line to show live in the dynamic region. */
  tail(): string {
    return this.buffer;
  }

  /** Flush whatever remains (message completed). */
  drain(): string[] {
    if (this.buffer.length === 0) return [];
    const rest = this.buffer;
    this.buffer = '';
    return [rest];
  }
}
