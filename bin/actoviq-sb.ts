#!/usr/bin/env node
/**
 * Actoviq Scrollback REPL — Claude Code-aligned scrollback terminal.
 *
 * Uses: native readline completer (Tab), history (↑↓), Ctrl+C abort,
 * streaming text output, thinking blocks, tool call progress, syntax
 * highlighting for code blocks. Renders to stdout — full terminal scrollback.
 */
import { createAgentSdk, loadJsonConfigFile, createActoviqCoreTools } from 'actoviq-agent-sdk';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

const WORK_DIR = process.argv[2] ?? process.cwd();
const CONFIG_PATH = process.argv[3] ?? path.join(os.homedir(), '.actoviq', 'settings.json');

let isGit = false;
try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); isGit = true; } catch {}

// ── ANSI colors ────────────────────────────────────────────────────

const C = {
  r: '\x1b[0m',       // reset
  d: '\x1b[2m',       // dim
  c: '\x1b[36m',      // cyan
  y: '\x1b[33m',      // yellow
  g: '\x1b[32m',      // green
  R: '\x1b[31m',      // red
  b: '\x1b[1m',       // bold
  m: '\x1b[35m',      // magenta
  w: '\x1b[37m',      // white
  bl: '\x1b[34m',     // blue
  // Backgrounds
  bgD: '\x1b[48;5;236m',  // dark gray bg for code
};

// ── System prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs directory a git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
  `# Tone and style\n- Only use emojis if the user explicitly requests it.\n- Your responses should be short and concise.\n\n` +
  `# Doing tasks\n- Prefer editing existing files to creating new ones.\n- Default to writing no comments.\n\n` +
  `# Git Safety Protocol\n- NEVER run destructive git commands unless explicitly requested.\n- NEVER commit changes unless explicitly asked.\n\n` +
  `# Other\n- NEVER create documentation files (*.md) unless explicitly requested.`;

// ── Commands ────────────────────────────────────────────────────────

const COMMANDS: Record<string, { desc: string }> = {
  help:    { desc: 'Show available commands' },
  clear:   { desc: 'Clear the screen' },
  exit:    { desc: 'Quit the REPL' },
  compact: { desc: 'Compact the current session' },
  memory:  { desc: 'Show memory/compact state' },
  model:   { desc: 'Show or change the model' },
  tools:   { desc: 'List available tools' },
  dream:   { desc: 'Trigger memory consolidation' },
  session: { desc: 'Session management' },
  agents:  { desc: 'List registered agents' },
  skills:  { desc: 'List available skills' },
};

function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const partial = line.slice(1).toLowerCase();
  const hits = Object.keys(COMMANDS).filter(c => c.startsWith(partial));
  return [hits.map(h => (hits.length === 1 ? `/${h} ` : `/${h}`)), line];
}

// ── Rendering helpers ───────────────────────────────────────────────

function hr(text?: string) {
  const w = process.stdout.columns || 80;
  if (text) {
    const pad = Math.max(0, w - text.length - 4);
    process.stdout.write(`${C.d}${'─'.repeat(2)} ${text} ${'─'.repeat(pad)}${C.r}\n`);
  } else {
    process.stdout.write(`${C.d}${'─'.repeat(w)}${C.r}\n`);
  }
}

function divider(label: string) {
  process.stdout.write(`\n${C.d}── ${label} ──${C.r}\n`);
}

function toolCall(name: string, input: Record<string, unknown>) {
  const inp = JSON.stringify(input);
  const short = inp.length > 120 ? inp.slice(0, 120) + '...' : inp;
  process.stdout.write(`${C.y}  ⚡ ${name}${C.r} ${C.d}${short}${C.r}\n`);
}

function toolResult(isError: boolean, name: string, durMs?: number, output?: unknown) {
  const ok = isError ? `${C.R}✗` : `${C.g}✓`;
  const dur = durMs ? ` ${durMs < 1000 ? durMs + 'ms' : (durMs / 1000).toFixed(1) + 's'}` : '';
  let out = '';
  if (typeof output === 'string') out = output.slice(0, 200);
  else if (output !== undefined && output !== null) out = JSON.stringify(output).slice(0, 200);
  process.stdout.write(`${ok}${C.r}${C.d}${dur}${C.r} ${C.d}${out}${C.r}\n`);
}

function thinking(text: string) {
  const lines = text.split('\n');
  const preview = lines[0] ?? text;
  process.stdout.write(`${C.d}💭 ${preview.slice(0, 300)}${preview.length > 300 ? '...' : ''}${C.r}\n`);
}

let borderDrawn = false;
function drawBorder() {
  if (borderDrawn) return;
  process.stdout.write(`${C.d}${'─'.repeat(process.stdout.columns || 80)}${C.r}\n`);
}

function clearBorder() { borderDrawn = false; }

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  process.stdout.write(`\n${C.c}${C.b}╭─ Actoviq ─────────────────────────────────────────╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  work dir : ${C.y}${WORK_DIR}${C.r}\n`);

  try { await loadJsonConfigFile(CONFIG_PATH); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: `actoviq — ${path.basename(WORK_DIR)}` });

  process.stdout.write(`${C.c}│${C.r}  model    : ${C.y}${sdk.config.model}${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  tools    : ${C.y}${tools.length}${C.r}  (Read, Write, Edit, Glob, Grep, Bash, ...)\n`);
  process.stdout.write(`${C.c}│${C.r}  commands : Tab to complete  |  ↑↓ history  |  Ctrl+C abort\n`);
  process.stdout.write(`${C.c}├──────────────────────────────────────────────────┤${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;

  // ── Message processor ──────────────────────────────────────────

  async function processMessage(text: string) {
    const t = text.trim();
    if (!t) return;
    clearBorder();

    // ── Slash commands ──────────────────────────────────────────
    if (t.startsWith('/')) {
      const sp = t.indexOf(' '); const cmd = sp === -1 ? t.slice(1) : t.slice(1, sp);
      switch (cmd) {
        case 'exit': process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); process.exit(0);
        case 'clear': process.stdout.write('\x1b[2J\x1b[H'); return;
        case 'help':
          process.stdout.write(`\n${C.b}Commands:${C.r}\n`);
          for (const [k, v] of Object.entries(COMMANDS)) {
            process.stdout.write(`  ${C.y}/${k.padEnd(10)}${C.r} ${C.d}${v.desc}${C.r}\n`);
          }
          process.stdout.write(`\n`);
          return;
        case 'model': process.stdout.write(`${C.d}Current model: ${C.y}${sdk.config.model}${C.r}\n\n`); return;
        case 'tools': process.stdout.write(`${C.d}${tools.map(t => `${C.y}${t.name}${C.r}${C.d}`).join(', ')}${C.r}\n\n`); return;
        case 'memory':
          try { const s = await session.compactState(); process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); }
          catch { process.stdout.write(`${C.d}No compact state available.${C.r}\n\n`); }
          return;
        case 'compact':
          try { const r = await session.compact({ force: true });
            process.stdout.write(`${C.g}✓ Compacted: ${(r as any).messagesRemoved ?? '?'} messages removed${C.r}\n\n`);
          } catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        case 'dream':
          try { await session.dream({ force: true }); process.stdout.write(`${C.g}✓ Dream triggered${C.r}\n\n`); }
          catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        default:
          process.stdout.write(`${C.R}Unknown command: /${cmd}${C.r}  ${C.d}Type /help for available commands.${C.r}\n\n`);
          return;
      }
    }

    // ── User message → model ────────────────────────────────────

    abortCtrl = new AbortController();
    const stream = session.stream(t, {
      tools, systemPrompt: SYSTEM_PROMPT, signal: abortCtrl.signal, model: sdk.config.model,
    });

    let iteration = 0;
    let currentText = '';
    let activeTools = new Map<string, { name: string; start: number }>();
    let hasOutput = false;

    for await (const event of stream) {
      switch (event.type) {
        case 'request.started':
          iteration = event.iteration;
          currentText = '';
          if (iteration > 1) divider(`iteration ${iteration}`);
          hasOutput = false;
          break;

        case 'response.text.delta': {
          const txt = typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '';
          // Highlight code blocks
          if (!hasOutput && iteration === 1 && txt.length > 0) hasOutput = true;
          process.stdout.write(highlightInline(txt));
          currentText += txt;
          break;
        }

        case 'response.content':
          if (event.content.type === 'thinking') {
            thinking((event.content as any).thinking ?? '');
          }
          break;

        case 'tool.call': {
          const { id, name, input } = event.call;
          activeTools.set(id, { name, start: Date.now() });
          toolCall(name, input as Record<string, unknown>);
          break;
        }

        case 'tool.progress': {
          const prog = event.data as { message?: string; type?: string; count?: number };
          if (prog?.message) process.stdout.write(`\r\x1b[K${C.d}     ${prog.message}${C.r}`);
          break;
        }

        case 'tool.result': {
          const info = activeTools.get(event.result.id);
          activeTools.delete(event.result.id);
          const dur = info ? Date.now() - info.start : undefined;
          toolResult(event.result.isError, info?.name ?? 'tool', dur, event.result.output);
          break;
        }

        case 'session.compacted':
          process.stdout.write(`\n${C.d}── context compacted ──${C.r}\n`);
          break;

        case 'error':
          process.stdout.write(`\n${C.R}  ✕ ${event.error.message}${C.r}\n`);
          break;
      }
    }

    const r = await stream.result;
    if (!hasOutput && r.text) process.stdout.write(r.text);
    drawBorder();
  }

  // ── Readline ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: `${C.c}> ${C.r}`,
    completer, historySize: 1000, terminal: true,
  });

  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
      cc++;
      if (cc >= 2) { process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) { abortCtrl.abort(); process.stdout.write(`\n${C.y}  ⏹ Aborting...${C.r}\n`); }
      process.stdout.write('\n'); rl.prompt();
      return;
    }
    cc = 0;
  });

  rl.prompt();

  rl.on('line', async (line) => {
    abortCtrl = null;
    try { await processMessage(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}  ⏹ aborted${C.r}\n\n`);
      else process.stdout.write(`\n${C.R}  ✕ ${(e as Error).message}${C.r}\n\n`);
    }
    rl.prompt();
  });

  rl.on('SIGINT', () => { rl.close(); });
  rl.on('close', async () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`\n${C.d}Session closed.${C.r}\n`);
    try { await sdk.close(); } catch {}
    process.exit(0);
  });
}

// ── Inline syntax highlighting ─────────────────────────────────────

function highlightInline(text: string): string {
  // Quick inline code highlight: `text`
  return text.replace(/`([^`]+)`/g, `${C.y}$1${C.r}`);
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
