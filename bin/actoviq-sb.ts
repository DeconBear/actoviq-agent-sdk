#!/usr/bin/env node
/**
 * Scrollback REPL — native terminal scrollback via pure stdout + readline.
 * No Ink/alternate screen. Messages stream directly to the main buffer.
 * Inspired by Claude Code's non-fullscreen mode.
 */
import { createAgentSdk, loadJsonConfigFile, createActoviqCoreTools } from 'actoviq-agent-sdk';
import type { AgentSession } from 'actoviq-agent-sdk';
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

async function main() {
  // Print header
  process.stdout.write(`\n${C.c}${C.b}Actoviq${C.r} ${C.d}| scrollback mode${C.r}\n`);
  process.stdout.write(`${C.d}work dir: ${WORK_DIR}${C.r}\n`);

  // Load config
  try { await loadJsonConfigFile(CONFIG_PATH); } catch {}
  const sdk = await createAgentSdk({ workDir: WORK_DIR });
  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  const session = await sdk.createSession({ title: `actoviq — ${path.basename(WORK_DIR)}` });

  process.stdout.write(`${C.d}model: ${sdk.config.model}  |  tools: ${tools.length}  |  session: ${path.basename(WORK_DIR)}${C.r}\n`);
  process.stdout.write(`${C.d}/help /clear /compact /exit  |  Ctrl+C abort  |  scroll to see history${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  let pending = false;

  // ── Process one message ────────────────────────────────────────

  async function handleSend(text: string) {
    const t = text.trim();
    if (!t) return;

    // Slash commands
    if (t === '/exit') { process.stdout.write(`${C.d}Goodbye.${C.r}\n`); process.exit(0); }
    if (t === '/clear') { process.stdout.write('\x1b[2J\x1b[H'); return; }
    if (t === '/help') {
      process.stdout.write(`${C.b}Commands:${C.r}\n  /help /clear /compact /memory /exit\n  Ctrl+C — abort current request\n\n`);
      return;
    }
    if (t === '/compact') {
      try { await session.compact({ force: true }); process.stdout.write(`${C.g}Compacted.${C.r}\n\n`); } catch (e: any) { process.stdout.write(`${C.R}${e.message}${C.r}\n\n`); }
      return;
    }
    if (t === '/memory') {
      try { const s = await session.compactState(); process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); } catch { process.stdout.write(`${C.d}No state.${C.r}\n\n`); }
      return;
    }

    // User message
    process.stdout.write(`${C.c}>${C.r} ${t}\n`);
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
            process.stdout.write(`\n${C.d}💭 ${(event.content as any).thinking?.slice(0, 250) ?? ''}${C.r}\n`);
          }
          break;
        case 'tool.call':
          process.stdout.write(`\n${C.y}  ⚡ ${event.call.name}${C.r}\n`);
          break;
        case 'tool.result': {
          const m = event.result.isError ? `${C.R}✗` : `${C.g}✓`;
          const o = typeof event.result.output === 'string' ? event.result.output.slice(0, 250) : JSON.stringify(event.result.output).slice(0, 250);
          process.stdout.write(`${m}${C.r} ${C.d}${o}${C.r}\n`);
          break;
        }
        case 'error':
          process.stdout.write(`\n${C.R}✕ ${event.error.message}${C.r}\n`);
          break;
      }
    }

    const r = await stream.result;
    process.stdout.write(`${C.d}[${r.requests.length} reqs, ${r.toolCalls.length} tools, ${r.stopReason}]${C.r}\n\n`);
  }

  // ── Readline input ─────────────────────────────────────────────

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.c}> ${C.r}`, terminal: true });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;
  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
      cc++;
      if (cc >= 2) { process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`); rl.close(); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) { abortCtrl.abort(); process.stdout.write(`\n${C.y}⏹ Aborting...${C.r}\n`); rl.prompt(); }
      cc = 0;
    }
  });

  rl.prompt();

  rl.on('line', async (line) => {
    abortCtrl = null;
    if (pending) return;
    pending = true;
    try { await handleSend(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}⏹ aborted${C.r}\n\n`);
      else process.stdout.write(`\n${C.R}✕ ${e.message}${C.r}\n\n`);
    }
    pending = false;
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
