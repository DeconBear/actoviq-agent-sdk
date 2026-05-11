#!/usr/bin/env node
/**
 * Actoviq — Claude Code-aligned terminal agent.
 *
 * Default: scrollback mode (main terminal buffer, native scrollback).
 * Ctrl+O: toggle fullscreen mode (Ink alt-screen with rich UI).
 *
 * Architecture: pure stdout streaming + readline for scrollback;
 * Ink for fullscreen overlay. Both share the same SDK session.
 */
import { createAgentSdk, loadJsonConfigFile, createActoviqCoreTools } from 'actoviq-agent-sdk';
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

const WORK_DIR = process.argv[2] ?? process.cwd();
const CONFIG_PATH = process.argv[3] ?? path.join(os.homedir(), '.actoviq', 'settings.json');

let isGit = false;
try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); isGit = true; } catch {}

// ── ANSI ────────────────────────────────────────────────────────────

const C = { r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m', g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m' };

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
  `# Tone and style\n- Only use emojis if user explicitly requests.\n- Responses short and concise.\n\n` +
  `# Tasks\n- Prefer editing existing files to creating new ones.\n- Default to no comments.\n\n` +
  `# Git Safety\n- Never destructive git commands unless requested.\n- Never commit unless asked.\n\n` +
  `# Rules\n- Never create *.md files unless explicitly requested.`;

const CMDS: Record<string, { desc: string }> = {
  help: { desc: 'Show available commands' },
  clear: { desc: 'Clear the screen' },
  exit: { desc: 'Quit' },
  compact: { desc: 'Compact the current session' },
  memory: { desc: 'Show memory/compact state' },
  model: { desc: 'Show current model' },
  tools: { desc: 'List available tools' },
  dream: { desc: 'Trigger memory consolidation' },
};

function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const partial = line.slice(1).toLowerCase();
  const hits = Object.keys(CMDS).filter(c => c.startsWith(partial));
  return [hits.map(h => hits.length === 1 ? `/${h} ` : `/${h}`), line];
}

// ── Render helpers ──────────────────────────────────────────────────

function statusLine(model: string, session: string, msgs: number, streaming: boolean) {
  const w = process.stdout.columns || 80;
  const left = `${C.d}${model}${C.r} ${C.d}|${C.r} ${session} ${C.d}|${C.r} ${msgs} msgs`;
  const right = streaming ? `${C.y}streaming...${C.r}` : `${C.d}/help${C.r}`;
  const pad = Math.max(1, w - stripAnsi(left) - stripAnsi(right));
  process.stdout.write(`\r${left}${' '.repeat(pad)}${right}`);
}

function stripAnsi(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function toolLine(name: string, input: Record<string, unknown>) {
  const inp = JSON.stringify(input);
  process.stdout.write(`${C.y}  ⚡ ${name}${C.r} ${C.d}${inp.slice(0, 120)}${inp.length > 120 ? '...' : ''}${C.r}\n`);
}

function resultLine(isErr: boolean, dur?: number, output?: unknown) {
  const ok = isErr ? `${C.R}✗` : `${C.g}✓`;
  const d = dur ? ` ${dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's'}` : '';
  let o = ''; if (typeof output === 'string') o = output.slice(0, 200);
  else if (output) o = JSON.stringify(output).slice(0, 200);
  process.stdout.write(`${ok}${C.r}${C.d}${d} ${o}${C.r}\n`);
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // Header
  process.stdout.write(`\n${C.c}${C.b}╭─ Actoviq ─────────────────────────────────────────╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  dir     : ${C.y}${WORK_DIR}${C.r}\n`);

  try { await loadJsonConfigFile(CONFIG_PATH); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: path.basename(WORK_DIR) });

  process.stdout.write(`${C.c}│${C.r}  model   : ${C.y}${sdk.config.model}${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  tools   : ${C.y}${tools.length} tools loaded${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  keys    : Tab=complete  ↑↓=history  Ctrl+C=abort  Ctrl+O=fullscreen${C.r}\n`);
  process.stdout.write(`${C.c}├──────────────────────────────────────────────────┤${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  let msgCount = 0;

  // ── Process message ────────────────────────────────────────────

  async function processMsg(text: string) {
    const t = text.trim();
    if (!t) return;
    msgCount++;

    if (t.startsWith('/')) {
      const sp = t.indexOf(' '); const cmd = sp === -1 ? t.slice(1) : t.slice(1, sp);
      switch (cmd) {
        case 'exit': process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); process.exit(0);
        case 'clear': process.stdout.write('\x1b[2J\x1b[H'); return;
        case 'help':
          process.stdout.write(`\n${C.b}Commands:${C.r}\n`);
          for (const [k, v] of Object.entries(CMDS))
            process.stdout.write(`  ${C.y}/${k.padEnd(10)}${C.r} ${C.d}${v.desc}${C.r}\n`);
          process.stdout.write(`\n`);
          return;
        case 'model': process.stdout.write(`${C.d}Model: ${C.y}${sdk.config.model}${C.r}\n\n`); return;
        case 'tools': process.stdout.write(`${C.d}${tools.map(t => `${C.y}${t.name}${C.r}`).join(', ')}${C.d}${C.r}\n\n`); return;
        case 'memory':
          try { const s = await session.compactState();
            process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); } catch { process.stdout.write(`${C.d}N/A${C.r}\n\n`); }
          return;
        case 'compact':
          try { const r = await session.compact({ force: true });
            process.stdout.write(`${C.g}✓ Compacted: ${(r as any).messagesRemoved ?? '?'} msgs removed${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        case 'dream':
          try { await session.dream({ force: true }); process.stdout.write(`${C.g}✓ Dream triggered${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        default:
          process.stdout.write(`${C.R}Unknown: /${cmd}${C.r}  ${C.d}Type /help${C.r}\n\n`);
          return;
      }
    }

    abortCtrl = new AbortController();
    const stream = session.stream(t, {
      tools, systemPrompt: SYSTEM_PROMPT, signal: abortCtrl.signal, model: sdk.config.model,
    });
    let iteration = 0;
    let hasText = false;
    const activeTools = new Map<string, { name: string; start: number }>();

    for await (const event of stream) {
      switch (event.type) {
        case 'request.started':
          iteration = event.iteration;
          if (iteration > 1) process.stdout.write(`\n${C.d}── iteration ${iteration} ──${C.r}\n`);
          break;
        case 'response.text.delta': {
          const txt = typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '';
          process.stdout.write(txt);
          hasText = true;
          break;
        }
        case 'response.content':
          if (event.content.type === 'thinking') {
            const th = ((event.content as any).thinking ?? '').slice(0, 250);
            process.stdout.write(`\n${C.d}💭 ${th}${C.r}\n`);
          }
          break;
        case 'tool.call': {
          activeTools.set(event.call.id, { name: event.call.name, start: Date.now() });
          toolLine(event.call.name, event.call.input as Record<string, unknown>);
          break;
        }
        case 'tool.progress': {
          const p = event.data as any;
          if (p?.message) process.stdout.write(`\r\x1b[K${C.d}     ${p.message}${C.r}`);
          break;
        }
        case 'tool.result': {
          const info = activeTools.get(event.result.id);
          activeTools.delete(event.result.id);
          resultLine(event.result.isError, info ? Date.now() - info.start : undefined, event.result.output);
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
    if (!hasText) { const r = await stream.result; if (r.text) process.stdout.write(r.text); }
    process.stdout.write(`\n`);
  }

  // ── Permission handler (y/n inline) ───────────────────────────

  async function processMsgWithPerms(text: string) {
    await processMsg(text);
  }

  // ── Fullscreen launcher ────────────────────────────────────────

  function launchFullscreen() {
    const tuiBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tui', 'bin', 'actoviq.cjs');
    process.stdout.write(`\n${C.d}Launching fullscreen TUI (session: ${session.id})...${C.r}\n`);
    // Use actoviq-fullscreen command or fall back to direct node invocation
    const child = spawn(process.execPath, [tuiBin, '--project', WORK_DIR, '--session', session.id, '--config', CONFIG_PATH], {
      cwd: WORK_DIR, stdio: 'inherit', shell: false,
    });
    child.on('exit', () => {
      process.stdout.write(`\n${C.d}Back to scrollback mode. Session preserved.${C.r}\n\n`);
      rl.prompt();
    });
  }

  // ── Readline ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: '', completer, historySize: 1000, terminal: true,
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
    if (key?.name === 'o' && key?.ctrl) {
      launchFullscreen();
      return;
    }
    cc = 0;
  });

  // Manual prompt since readline prompt is empty
  process.stdout.write(`${C.c}> ${C.r}`);
  rl.write('');

  rl.on('line', async (line) => {
    abortCtrl = null;
    try { await processMsgWithPerms(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}  ⏹ aborted${C.r}\n`);
      else process.stdout.write(`\n${C.R}  ✕ ${(e as Error).message}${C.r}\n`);
    }
    process.stdout.write(`${C.c}> ${C.r}`);
  });

  rl.on('close', async () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`);
    try { await sdk.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
