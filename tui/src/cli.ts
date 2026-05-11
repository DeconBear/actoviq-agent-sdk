#!/usr/bin/env node
/**
 * Actoviq — Claude Code-aligned terminal agent.
 *
 * Pure TypeScript. No Ink, no React. Messages stream to stdout
 * (main terminal buffer = native scrollback). Input via readline.
 * Bottom bar re-rendered in-place via ANSI cursor positioning.
 */
import { createAgentSdk, loadJsonConfigFile, createActoviqCoreTools } from 'actoviq-agent-sdk';
import type { AgentSession, ActoviqPermissionMode } from 'actoviq-agent-sdk';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

// ═══════════════════════════════════════════════════════════════════════
//  ANSI rendering primitives
// ═══════════════════════════════════════════════════════════════════════

const C = {
  r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m',
  g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m', m: '\x1b[35m',
};

const CSI = '\x1b[';
function cu(x: number, y: number) { return `${CSI}${y + 1};${x + 1}H`; }
function strip(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

function drawBottom(model: string, sessionName: string, msgs: number, streaming: boolean, mode: string, inp: string) {
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;

  // Input line
  const border = C.d + '─'.repeat(W - 2) + C.r;
  process.stdout.write(`${cu(1, H - 3)}${C.d}┌${border}┐${C.r}`);
  const prefix = ` ${C.c}${C.b}>${C.r} `;
  const display = streaming ? `${C.d}Waiting for response...${C.r}`
    : inp ? inp.slice(0, W - strip(prefix) - 4)
    : `${C.d}Type a message (Enter to send, / for commands)...${C.r}`;
  const pad = Math.max(0, W - 2 - strip(prefix) - strip(display));
  process.stdout.write(`${cu(1, H - 2)}${C.d}│${C.r}${prefix}${display}${' '.repeat(pad)}${C.d}│${C.r}`);
  process.stdout.write(`${cu(1, H - 1)}${C.d}└${border}┘${C.r}`);

  // Status
  const left = `${C.d}${model}${C.r} ${C.d}|${C.r} ${sessionName} ${C.d}|${C.r} ${msgs} msgs ${C.d}|${C.r} ${mode}`;
  const right = streaming ? `${C.y}⚡ streaming...${C.r}` : `${C.d}/help${C.r}`;
  const spad = Math.max(1, W - strip(left) - strip(right));
  process.stdout.write(`${cu(1, H)}${left}${' '.repeat(spad)}${right}${C.r}`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Stream processor
// ═══════════════════════════════════════════════════════════════════════

async function runStream(
  session: AgentSession, text: string, model: string,
  tools: any[], systemPrompt: string, signal: AbortSignal,
) {
  const stream = session.stream(text, { tools, systemPrompt, model, signal });
  let iteration = 0;
  let hasOutput = false;
  const active = new Map<string, { name: string; start: number }>();

  for await (const event of stream) {
    switch (event.type) {
      case 'request.started':
        iteration = event.iteration;
        if (iteration > 1) process.stdout.write(`\n${C.d}── iteration ${iteration} ──${C.r}\n`);
        break;

      case 'response.text.delta': {
        const txt = typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '';
        process.stdout.write(txt);
        hasOutput = true;
        break;
      }

      case 'response.content':
        if (event.content.type === 'thinking') {
          const th = ((event.content as any).thinking ?? '').slice(0, 300);
          process.stdout.write(`\n${C.d}💭 ${th}${C.r}\n`);
        }
        break;

      case 'tool.call': {
        active.set(event.call.id, { name: event.call.name, start: Date.now() });
        const inp = JSON.stringify(event.call.input);
        process.stdout.write(`\n${C.y}  ⚡ ${event.call.name}${C.r} ${C.d}${inp.slice(0, 120)}${inp.length > 120 ? '...' : ''}${C.r}\n`);
        break;
      }

      case 'tool.progress': {
        const p = event.data as any;
        if (p?.message) process.stdout.write(`\r${CSI}2K${C.d}     ${p.message}${C.r}`);
        break;
      }

      case 'tool.result': {
        const info = active.get(event.result.id);
        active.delete(event.result.id);
        const dur = info ? Date.now() - info.start : undefined;
        const ok = event.result.isError ? `${C.R}✗` : `${C.g}✓`;
        const d = dur ? ` ${dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's'}` : '';
        const o = typeof event.result.output === 'string'
          ? event.result.output.slice(0, 200) : '';
        process.stdout.write(`${ok}${C.r}${C.d}${d} ${o}${C.r}\n`);
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
  return { hasOutput };
}

// ═══════════════════════════════════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════════════════════════════════

const CMDS: Record<string, string> = {
  help:    'Show available commands',
  clear:   'Clear the screen',
  exit:    'Quit',
  compact: 'Compact the current session',
  memory:  'Show memory/compact state',
  model:   'Show or change the model',
  tools:   'List available tools',
  dream:   'Trigger memory consolidation',
  perm:    'Cycle permission mode',
  session: 'Session management',
  agents:  'List registered agents',
  skills:  'List available skills',
};

function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const partial = line.slice(1).toLowerCase();
  const hits = Object.keys(CMDS).filter(c => c.startsWith(partial));
  return [hits.map(h => hits.length === 1 ? `/${h} ` : `/${h}`), line];
}

// ═══════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════

const WORK_DIR = process.argv[2] ?? process.cwd();
const CFG = process.argv[3] ?? path.join(os.homedir(), '.actoviq', 'settings.json');

async function main() {
  // Header
  const W = process.stdout.columns || 80;
  process.stdout.write(`${C.c}${C.b}╭${'─'.repeat(Math.min(W - 2, 60))}╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  Actoviq  ${C.d}|${C.r}  ${WORK_DIR.slice(0, 40)}\n`);

  try { await loadJsonConfigFile(CFG); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: path.basename(WORK_DIR) });

  const isGit = (() => { try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); return true; } catch { return false; } })();
  const systemPrompt =
    `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
    `<env>\nWorking directory: ${WORK_DIR}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
    `# Guidelines\n- Prefer editing existing files.\n- Default to no comments.\n- Never destructive git unless asked.\n- Never create *.md unless asked.`;

  process.stdout.write(`${C.c}│${C.r}  model: ${C.y}${sdk.config.model}${C.r}  ${C.d}|${C.r}  tools: ${tools.length}\n`);
  process.stdout.write(`${C.c}├${'─'.repeat(Math.min(W - 2, 60))}┤${C.r}\n\n`);

  let model = sdk.config.model;
  let permMode: ActoviqPermissionMode = 'bypassPermissions';
  let abortCtrl: AbortController | null = null;
  let streaming = false;
  let msgCount = 0;

  // ── Readline ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: '', completer, historySize: 1000, terminal: true,
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;
  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
      cc++;
      if (cc >= 2) { process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) { abortCtrl.abort(); process.stdout.write(`\n${C.y}  ⏹ Aborting...${C.r}\n`); }
      process.stdout.write('\n'); rl.write('');
      return;
    }
    cc = 0;
  });

  function refresh() {
    drawBottom(model, path.basename(WORK_DIR), msgCount, streaming, permMode, (rl as any).line ?? '');
  }

  const timer = setInterval(refresh, 150);

  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) { rl.write(''); return; }

    // ── Slash commands ──────────────────────────────────────────
    if (t.startsWith('/')) {
      const sp = t.indexOf(' '); const cmd = sp === -1 ? t.slice(1) : t.slice(1, sp);
      switch (cmd) {
        case 'exit': process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return;
        case 'clear': process.stdout.write('\x1b[2J\x1b[H'); rl.write(''); refresh(); return;
        case 'help':
          process.stdout.write(`\n${C.b}Commands:${C.r}\n`);
          for (const [k, v] of Object.entries(CMDS))
            process.stdout.write(`  ${C.y}/${k.padEnd(10)}${C.r} ${C.d}${v}${C.r}\n`);
          process.stdout.write(`\n${C.d}Tab=complete  ↑↓=history  Ctrl+C=abort${C.r}\n\n`);
          rl.write(''); refresh(); return;
        case 'model':
          if (sp >= 0) { model = t.slice(sp + 1).trim(); process.stdout.write(`${C.g}Model: ${model}${C.r}\n\n`); }
          else process.stdout.write(`${C.d}Model: ${C.y}${model}${C.r}\n\n`);
          rl.write(''); refresh(); return;
        case 'tools':
          process.stdout.write(`${C.d}${tools.map(t => `${C.y}${t.name}${C.r}`).join(', ')}${C.d}${C.r}\n\n`);
          rl.write(''); refresh(); return;
        case 'memory':
          try { const s = await session.compactState(); process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); }
          catch { process.stdout.write(`${C.d}N/A${C.r}\n\n`); }
          rl.write(''); refresh(); return;
        case 'compact':
          try { const r = await session.compact({ force: true }); process.stdout.write(`${C.g}✓ Compacted${C.r}\n\n`); }
          catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          rl.write(''); refresh(); return;
        case 'dream':
          try { await session.dream({ force: true }); process.stdout.write(`${C.g}✓ Dream triggered${C.r}\n\n`); }
          catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          rl.write(''); refresh(); return;
        case 'perm': {
          const modes: ActoviqPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
          permMode = modes[(modes.indexOf(permMode) + 1) % modes.length]!;
          process.stdout.write(`${C.y}Permission: ${permMode}${C.r}\n\n`);
          rl.write(''); refresh(); return;
        }
        default:
          process.stdout.write(`${C.R}Unknown: /${cmd}${C.r}\n\n`);
          rl.write(''); refresh(); return;
      }
    }

    // ── User message → model ────────────────────────────────────
    process.stdout.write(`${C.c}> ${C.r}${t}\n`);
    msgCount++;

    abortCtrl = new AbortController();
    streaming = true;
    refresh();

    try {
      await runStream(session, t, model, tools, systemPrompt, abortCtrl.signal);
    } catch (e: any) {
      if (e.name !== 'AbortError') process.stdout.write(`\n${C.R}✕ ${e.message}${C.r}\n`);
    }

    streaming = false;
    abortCtrl = null;
    process.stdout.write('\n');
    refresh();
    rl.write('');
  });

  rl.on('close', async () => {
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`);
    try { await sdk.close(); } catch {}
    process.exit(0);
  });

  // Initial render
  refresh();
  rl.write('');
}

main().catch(e => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
