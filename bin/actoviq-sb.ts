#!/usr/bin/env node
/**
 * Actoviq Scrollback REPL — native terminal scrollback via pure stdout + readline.
 * Inspired by Claude Code's non-fullscreen mode.
 * Features: slash command autocomplete, history navigation, rich tool rendering.
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

const C = { r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m', g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m', m: '\x1b[35m' };

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs directory a git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
  `# Tone and style\n- Only use emojis if the user explicitly requests it.\n- Your responses should be short and concise.\n\n` +
  `# Doing tasks\n- Prefer editing existing files to creating new ones.\n- Default to writing no comments.\n\n` +
  `# Git Safety Protocol\n- NEVER run destructive git commands unless explicitly requested.\n- NEVER commit changes unless explicitly asked.\n\n` +
  `# Other\n- NEVER create documentation files (*.md) unless explicitly requested.`;

// ── Slash commands ─────────────────────────────────────────────────

interface Cmd { name: string; desc: string; action?: () => Promise<void> | void }

function buildCommands(session: any): Cmd[] {
  return [
    { name: 'help', desc: 'Show available commands' },
    { name: 'clear', desc: 'Clear the screen', action: () => { process.stdout.write('\x1b[2J\x1b[H'); } },
    { name: 'exit', desc: 'Quit the REPL', action: () => { process.stdout.write(`${C.d}Goodbye.${C.r}\n`); process.exit(0); } },
    { name: 'compact', desc: 'Compact the current session', action: async () => {
      try { await session.compact({ force: true }); process.stdout.write(`${C.g}Compacted.${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}${e.message}${C.r}\n\n`); }
    }},
    { name: 'memory', desc: 'Show memory/compact state', action: async () => {
      try { const s = await session.compactState(); process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); } catch { process.stdout.write(`${C.d}No state.${C.r}\n\n`); }
    }},
    { name: 'model', desc: 'Show current model' },
    { name: 'tools', desc: 'List available tools' },
    { name: 'dream', desc: 'Trigger memory consolidation', action: async () => {
      try { await session.dream({ force: true }); process.stdout.write(`${C.g}Dream triggered.${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}${e.message}${C.r}\n\n`); }
    }},
    { name: 'session', desc: 'Session management (new/switch/list)' },
    { name: 'agents', desc: 'List registered agents' },
    { name: 'skills', desc: 'List available skills' },
  ];
}

// ── Autocomplete ───────────────────────────────────────────────────

function matchCommands(cmds: Cmd[], partial: string): Cmd[] {
  if (!partial.startsWith('/')) return [];
  const prefix = partial.slice(1).toLowerCase();
  return cmds.filter(c => c.name.startsWith(prefix));
}

// ── Helpers ────────────────────────────────────────────────────────

function clearLine() { process.stdout.write('\r\x1b[K'); }

function statusBar(model: string, msgs: number, streaming: boolean) {
  return `${C.d}${model} | ${msgs} msgs${streaming ? ' | streaming...' : ''} | /help for commands${C.r}`;
}


async function main() {
  // Print header
  process.stdout.write(`\n${C.c}${C.b}Actoviq${C.r} ${C.d}scrollback mode${C.r}\n`);
  process.stdout.write(`${C.d}work dir: ${WORK_DIR}${C.r}\n`);

  // Load config
  try { await loadJsonConfigFile(CONFIG_PATH); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: `actoviq — ${path.basename(WORK_DIR)}` });

  const cmds = buildCommands(session);
  let messageCount = 0;

  process.stdout.write(`${C.d}model: ${sdk.config.model}  |  tools: ${tools.length}  |  session: ${path.basename(WORK_DIR)}${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  let pending = false;
  const history: string[] = [];
  let historyIdx = -1;
  let currentInput = '';

  // ── Process one message ────────────────────────────────────────

  async function handleSend(text: string) {
    const t = text.trim();
    if (!t) return;

    history.push(t);
    historyIdx = -1;

    // Slash commands
    if (t.startsWith('/')) {
      const spaceIdx = t.indexOf(' ');
      const cmd = spaceIdx === -1 ? t.slice(1) : t.slice(1, spaceIdx);
      const found = cmds.find(c => c.name === cmd);
      if (found?.action) { await found.action(); return; }
      if (found) {
        if (cmd === 'model') { process.stdout.write(`${C.d}Model: ${sdk.config.model}${C.r}\n\n`); return; }
        if (cmd === 'tools') { process.stdout.write(`${C.d}Tools: ${tools.map(t => t.name).join(', ')}${C.r}\n\n`); return; }
        if (cmd === 'help') {
          process.stdout.write(C.b + '\nCommands:\n' + C.r);
          for (const c of cmds) process.stdout.write(`  ${C.y}/${c.name}${C.r} ${C.d}— ${c.desc}${C.r}\n`);
          process.stdout.write(`${C.d}\nCtrl+C — abort${C.r}\n\n`);
          return;
        }
      }
      // Unknown command — treat as message to model
    }

    abortCtrl = new AbortController();
    const stream = session.stream(t, { tools, systemPrompt: SYSTEM_PROMPT, signal: abortCtrl.signal, model: sdk.config.model });
    let iteration = 0;

    for await (const event of stream) {
      switch (event.type) {
        case 'request.started':
          iteration = event.iteration;
          if (iteration > 1) process.stdout.write(`\n${C.d}── iteration ${iteration} ──${C.r}\n`);
          break;
        case 'response.text.delta': {
          const txt = typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '';
          process.stdout.write(txt);
          break;
        }
        case 'response.content':
          if (event.content.type === 'thinking') {
            const th = (event.content as any).thinking ?? '';
            process.stdout.write(`\n${C.d}💭 ${th.slice(0, 250)}${th.length > 250 ? '...' : ''}${C.r}\n`);
          }
          break;
        case 'tool.call': {
          const input = JSON.stringify(event.call.input);
          process.stdout.write(`\n${C.y}  ⚡ ${event.call.name}${C.r}${C.d}${input.length > 120 ? ' ' + input.slice(0, 120) + '...' : ' ' + input}${C.r}\n`);
          break;
        }
        case 'tool.result': {
          const m = event.result.isError ? `${C.R}✗` : `${C.g}✓`;
          const dur = event.result.durationMs ? ` ${event.result.durationMs}ms` : '';
          const o = typeof event.result.output === 'string' ? event.result.output.slice(0, 200) : JSON.stringify(event.result.output).slice(0, 200);
          process.stdout.write(`${m}${C.r}${C.d}${dur}${C.r} ${C.d}${o}${C.r}\n`);
          break;
        }
        case 'error':
          process.stdout.write(`\n${C.R}✕ ${event.error.message}${C.r}\n`);
          break;
      }
    }

    const r = await stream.result;
    messageCount++;
    process.stdout.write(`\n`);
  }

  // ── Input handling ─────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: '', terminal: true,
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // Write initial prompt and status
  process.stdout.write(C.c + '> ' + C.r);
  const statusLine = process.stdout.rows - 1;
  let lastCmdMatches: Cmd[] = [];

  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;

  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (!key) return;

    // Ctrl+C
    if (key.name === 'c' && key.ctrl) {
      cc++;
      if (cc >= 2) { process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) {
        abortCtrl.abort();
        process.stdout.write(`\n${C.y}⏹ Aborting...${C.r}\n`);
        rl.write(''); // trigger new prompt
      }
      cc = 0;
      return;
    }
    cc = 0;

    // Tab: autocomplete
    if (key.name === 'tab') {
      const line = (rl as any).line ?? currentInput;
      if (line.startsWith('/')) {
        const matches = matchCommands(cmds, line);
        if (matches.length === 1) {
          // Complete
          (rl as any).line = '/' + matches[0]!.name + ' ';
          (rl as any).cursor = (rl as any).line.length;
          process.stdout.write('\r\x1b[K' + C.c + '> ' + C.r + (rl as any).line);
          lastCmdMatches = [];
        } else if (matches.length > 1) {
          lastCmdMatches = matches;
          // Show matches below
          process.stdout.write('\n' + C.d + matches.map(m => '/' + m.name + ' — ' + m.desc).join('\n') + C.r);
          process.stdout.write('\n' + C.c + '> ' + C.r + ((rl as any).line ?? ''));
        }
      }
      return;
    }

    // Clear autocomplete on other input
    lastCmdMatches = [];

    // Up: history back
    if (key.name === 'up') {
      if (history.length === 0) return;
      if (historyIdx === -1) { currentInput = (rl as any).line ?? ''; historyIdx = history.length - 1; }
      else if (historyIdx > 0) historyIdx--;
      const entry = history[history.length - 1 - historyIdx] ?? '';
      (rl as any).line = entry;
      (rl as any).cursor = entry.length;
      process.stdout.write('\r\x1b[K' + C.c + '> ' + C.r + entry);
      return;
    }

    // Down: history forward
    if (key.name === 'down') {
      if (historyIdx === -1) return;
      historyIdx--;
      if (historyIdx < 0) {
        (rl as any).line = currentInput;
        (rl as any).cursor = currentInput.length;
        process.stdout.write('\r\x1b[K' + C.c + '> ' + C.r + currentInput);
        historyIdx = -1;
      } else {
        const entry = history[history.length - 1 - historyIdx] ?? '';
        (rl as any).line = entry;
        (rl as any).cursor = entry.length;
        process.stdout.write('\r\x1b[K' + C.c + '> ' + C.r + entry);
      }
      return;
    }

    // ESC: clear
    if (key.name === 'escape') {
      (rl as any).line = '';
      (rl as any).cursor = 0;
      process.stdout.write('\r\x1b[K' + C.c + '> ' + C.r);
      return;
    }
  });

  // rl.write() to show initial prompt
  rl.write('');

  rl.on('line', async (line) => {
    abortCtrl = null;
    if (pending) { rl.write(''); return; }
    pending = true;
    try { await handleSend(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}⏹ aborted${C.r}\n\n`);
      else process.stdout.write(`\n${C.R}✕ ${(e as Error).message}${C.r}\n\n`);
    }
    pending = false;
    process.stdout.write(C.c + '> ' + C.r);
  });

  rl.on('close', async () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\n');
    try { await sdk.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
