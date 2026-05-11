#!/usr/bin/env node
/**
 * Actoviq Scrollback REPL — native terminal scrollback via pure stdout + readline.
 * Uses readline's built-in completer for Tab autocomplete.
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

const C = { r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m', g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m' };

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs directory a git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
  `# Tone and style\n- Only use emojis if the user explicitly requests it.\n- Your responses should be short and concise.\n\n` +
  `# Doing tasks\n- Prefer editing existing files to creating new ones.\n- Default to writing no comments.\n\n` +
  `# Git Safety Protocol\n- NEVER run destructive git commands unless explicitly requested.\n- NEVER commit changes unless explicitly asked.\n\n` +
  `# Other\n- NEVER create documentation files (*.md) unless explicitly requested.`;

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
  if (hits.length === 0) return [[], line];
  if (hits.length === 1) return [[`/${hits[0]!} `], line];
  return [hits.map(h => `/${h}`), line];
}

async function main() {
  process.stdout.write(`\n${C.c}${C.b}Actoviq${C.r} ${C.d}| scrollback${C.r}\n`);
  process.stdout.write(`${C.d}work dir: ${WORK_DIR}${C.r}\n`);

  try { await loadJsonConfigFile(CONFIG_PATH); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: `actoviq — ${path.basename(WORK_DIR)}` });

  process.stdout.write(`${C.d}model: ${sdk.config.model}  |  tools: ${tools.length}  |  /help${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  const history: string[] = [];

  // ── Message processor ─────────────────────────────────────────

  async function processMessage(text: string) {
    const t = text.trim();
    if (!t) return;

    history.push(t);

    // Slash commands
    if (t.startsWith('/')) {
      const sp = t.indexOf(' '); const cmd = sp === -1 ? t.slice(1) : t.slice(1, sp);
      switch (cmd) {
        case 'exit': process.stdout.write(`${C.d}Goodbye.${C.r}\n`); process.exit(0);
        case 'clear': process.stdout.write('\x1b[2J\x1b[H'); return;
        case 'help':
          process.stdout.write(`\n${C.b}Commands:${C.r}\n`);
          for (const [k, v] of Object.entries(COMMANDS)) process.stdout.write(`  ${C.y}/${k}${C.r} ${C.d}— ${v.desc}${C.r}\n`);
          process.stdout.write(`\n${C.d}Tab — autocomplete  |  Ctrl+C — abort  |  ↑↓ — history${C.r}\n\n`);
          return;
        case 'model': process.stdout.write(`${C.d}Model: ${sdk.config.model}${C.r}\n\n`); return;
        case 'tools': process.stdout.write(`${C.d}${tools.map(t => t.name).join(', ')}${C.r}\n\n`); return;
        case 'memory':
          try { const s = await session.compactState(); process.stdout.write(`${JSON.stringify(s as any, null, 2)}\n\n`); } catch { process.stdout.write(`${C.d}No state.${C.r}\n\n`); }
          return;
        case 'compact':
          try { await session.compact({ force: true }); process.stdout.write(`${C.g}Compacted.${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}${e.message}${C.r}\n\n`); }
          return;
        case 'dream':
          try { await session.dream({ force: true }); process.stdout.write(`${C.g}Dream triggered.${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}${e.message}${C.r}\n\n`); }
          return;
        default:
          process.stdout.write(`${C.R}Unknown command: /${cmd}${C.r}\n\n`);
          return;
      }
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
            const th = ((event.content as any).thinking ?? '').slice(0, 250);
            process.stdout.write(`\n${C.d}💭 ${th}${C.r}\n`);
          }
          break;
        case 'tool.call': {
          const inp = JSON.stringify(event.call.input);
          process.stdout.write(`\n${C.y}  ⚡ ${event.call.name}${C.r} ${C.d}${inp.length > 100 ? inp.slice(0, 100) + '...' : inp}${C.r}\n`);
          break;
        }
        case 'tool.result': {
          const ok = event.result.isError ? `${C.R}✗` : `${C.g}✓`;
          const dur = event.result.durationMs ? ` ${event.result.durationMs}ms` : '';
          const out = typeof event.result.output === 'string' ? event.result.output.slice(0, 200) : '';
          process.stdout.write(`${ok}${C.r}${C.d}${dur} ${out}${C.r}\n`);
          break;
        }
        case 'error':
          process.stdout.write(`\n${C.R}✕ ${event.error.message}${C.r}\n`);
          break;
      }
    }
    process.stdout.write('\n');
  }

  // ── Readline with completer & history ─────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: `${C.c}> ${C.r}`,
    completer,
    historySize: 1000,
    terminal: true,
  });

  // Feed command history entries into readline's internal history
  // so Up/Down navigation works natively (readline only stores lines submitted via line event)
  const origHistory = (rl as any)._history as string[] | undefined;

  // Ctrl+C handling
  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
      cc++;
      if (cc >= 2) { process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) {
        abortCtrl.abort();
        process.stdout.write(`\n${C.y}⏹ Aborting...${C.r}\n`);
      }
      process.stdout.write('\n');
      rl.prompt();
      return;
    }
    cc = 0;
  });

  rl.prompt();

  rl.on('line', async (line) => {
    abortCtrl = null;
    try { await processMessage(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}⏹ aborted${C.r}\n\n`);
      else process.stdout.write(`\n${C.R}✕ ${(e as Error).message}${C.r}\n\n`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\n');
    try { await sdk.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
