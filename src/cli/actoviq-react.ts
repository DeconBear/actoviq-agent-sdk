#!/usr/bin/env node
/**
 * Actoviq — Interactive terminal agent.
 *
 * Clean SDK scrollback-mode REPL with readline input, slash commands,
 * and real-time streaming output. Uses the main terminal buffer for
 * native scrollback.
 */
import {
  createAgentSdk,
  loadJsonConfigFile,
  loadDefaultActoviqSettings,
  createActoviqCoreTools,
  type ActoviqPermissionMode,
} from 'actoviq-agent-sdk';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

// Read package version from the nearest package.json. createRequire is
// used so this works in both ESM and CJS contexts. Falls back to "unknown"
// when the binary is detached from a package directory (e.g. running
// straight from a source checkout without `npm install`).
const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require('../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`actoviq-react ${VERSION}\n`);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    [
      'actoviq-react — Clean SDK scrollback REPL',
      '',
      'Usage: actoviq-react [work-dir] [config-path] [options]',
      '',
      'Arguments:',
      '  work-dir                    Working directory (default: cwd)',
      '  config-path                 Path to an Actoviq settings JSON file',
      '                             (default: ~/.actoviq/settings.json)',
      '',
      'Options:',
      '  -v, --version               Print the actoviq-react version and exit',
      '  -h, --help                  Show this help',
      '',
      'In the REPL, type /help for the list of slash commands.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const CONFIG_PATH = process.argv[3] ?? path.join(os.homedir(), '.actoviq', 'settings.json');
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
const PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
]);

let isGit = false;
try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); isGit = true; } catch {}

// ── ANSI ────────────────────────────────────────────────────────────

const C = {
  r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m',
  g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m', m: '\x1b[35m',
};

function stripAnsi(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// ── System prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\nDate: ${new Date().toISOString().slice(0, 10)}\n</env>\n\n` +
  `# Tone and style\n` +
  `- Only use emojis if the user explicitly requests it.\n` +
  `- Your responses should be short and concise.\n` +
  `- When referencing code include the pattern file_path:line_number.\n\n` +
  `# Doing tasks\n` +
  `- Prefer editing existing files to creating new ones.\n` +
  `- Do not add features, refactor, or introduce abstractions beyond what the task requires.\n` +
  `- Default to writing no comments.\n\n` +
  `# Git Safety Protocol\n` +
  `- NEVER update the git config\n` +
  `- NEVER run destructive git commands unless the user explicitly requests\n` +
  `- NEVER skip hooks unless the user explicitly requests it\n` +
  `- NEVER commit changes unless the user explicitly asks you to\n\n` +
  `# Other\n` +
  `- NEVER create documentation files (*.md) unless explicitly requested.\n` +
  `- When in doubt, use TodoWrite to track progress.`;

// ── Slash commands ────────────────────────────────────────────────────

const CMDS: Record<string, string> = {
  help:    'Show available commands',
  clear:   'Clear the screen',
  exit:    'Quit',
  compact: 'Compact the current session',
  memory:  'Show memory/compact state',
  model:   'Show or set the session model',
  permissions: 'Show or set the permission mode',
  sessions: 'List stored sessions',
  resume:  'Resume a stored session',
  tools:   'List available tools',
  dream:   'Trigger memory consolidation',
};

function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const partial = line.slice(1).toLowerCase();
  const hits = Object.keys(CMDS).filter(c => c.startsWith(partial));
  return [hits.map(h => hits.length === 1 ? `/${h} ` : `/${h}`), line];
}

// ── Render helpers ────────────────────────────────────────────────────

function toolLine(name: string, input: Record<string, unknown>) {
  const inp = JSON.stringify(input);
  process.stdout.write(`${C.y}  ⚡ ${name}${C.r} ${C.d}${inp.slice(0, 120)}${inp.length > 120 ? '...' : ''}${C.r}\n`);
}

function resultLine(isErr: boolean, dur?: number, output?: unknown) {
  const ok = isErr ? `${C.R}✗` : `${C.g}✓`;
  const d = dur ? ` ${dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's'}` : '';
  let o = '';
  if (typeof output === 'string') o = output.slice(0, 200);
  else if (output) o = JSON.stringify(output).slice(0, 200);
  process.stdout.write(`${ok}${C.r}${C.d}${d} ${o}${C.r}\n`);
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // Header
  const w = process.stdout.columns || 80;
  process.stdout.write(`\n${C.c}${C.b}╭${'─'.repeat(Math.min(w - 2, 60))}╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  dir     : ${C.y}${WORK_DIR.slice(0, 45)}${C.r}\n`);

  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
  try {
    if (process.argv[3]) await loadJsonConfigFile(CONFIG_PATH);
    else await loadDefaultActoviqSettings();
  } catch {}
  const sdk = await createAgentSdk({
    workDir: WORK_DIR,
    tools,
    permissionMode: DEFAULT_PERMISSION_MODE,
  });
  const toolMetadata = await sdk.listToolMetadata();
  let session = await sdk.createSession({
    title: path.basename(WORK_DIR),
    permissionMode: DEFAULT_PERMISSION_MODE,
  });

  process.stdout.write(`${C.c}│${C.r}  model   : ${C.y}${session.model}${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  tools   : ${C.y}${toolMetadata.length} tools loaded${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  keys    : Tab=complete  ↑↓=history  Ctrl+C=abort${C.r}\n`);
  process.stdout.write(`${C.c}├${'─'.repeat(Math.min(w - 2, 60))}┤${C.r}\n\n`);

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
            process.stdout.write(`  ${C.y}/${k.padEnd(10)}${C.r} ${C.d}${v}${C.r}\n`);
          process.stdout.write(`\n`);
          return;
        case 'model': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (!requested) {
            process.stdout.write(`${C.d}Model: ${C.y}${session.model}${C.r}\n\n`);
            return;
          }
          await session.setModel(requested === 'default' ? sdk.config.model : requested);
          process.stdout.write(`${C.g}Model set to ${C.y}${session.model}${C.r}\n\n`);
          return;
        }
        case 'permissions': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          const state = session.permissionContext;
          if (!requested) {
            process.stdout.write(
              `${C.d}Permissions: ${C.y}${state.mode ?? DEFAULT_PERMISSION_MODE}${C.r}` +
              `${C.d} (${state.permissions.length} session rules)${C.r}\n\n`,
            );
            return;
          }
          if (!PERMISSION_MODES.has(requested as ActoviqPermissionMode)) {
            process.stdout.write(
              `${C.R}Invalid mode. Use: ${[...PERMISSION_MODES].join(', ')}${C.r}\n\n`,
            );
            return;
          }
          await session.setPermissionContext({
            mode: requested as ActoviqPermissionMode,
            permissions: state.permissions,
          });
          process.stdout.write(`${C.g}Permission mode set to ${C.y}${requested}${C.r}\n\n`);
          return;
        }
        case 'sessions': {
          const sessions = await sdk.sessions.list();
          if (sessions.length === 0) {
            process.stdout.write(`${C.d}No stored sessions.${C.r}\n\n`);
            return;
          }
          for (const stored of sessions) {
            const current = stored.id === session.id ? '*' : ' ';
            process.stdout.write(
              `${C.d}${current} ${stored.id}  ${stored.title}  ${stored.model}${C.r}\n`,
            );
          }
          process.stdout.write('\n');
          return;
        }
        case 'resume': {
          const sessionId = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (!sessionId) {
            process.stdout.write(`${C.R}Usage: /resume <session-id>${C.r}\n\n`);
            return;
          }
          session = await sdk.resumeSession(sessionId);
          process.stdout.write(
            `${C.g}Resumed ${session.id}: ${session.title} (${session.model})${C.r}\n\n`,
          );
          return;
        }
        case 'tools':
          process.stdout.write(`${C.d}${toolMetadata.map(t => `${C.y}${t.name}${C.r}`).join(', ')}${C.r}\n\n`);
          return;
        case 'memory':
          try { const s = await session.compactState();
            process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); }
          catch { process.stdout.write(`${C.d}N/A${C.r}\n\n`); }
          return;
        case 'compact':
          try {
            const summaryInstructions = sp === -1 ? undefined : t.slice(sp + 1).trim() || undefined;
            const r = await session.compact({ force: true, summaryInstructions });
            if (!r.compacted) {
              process.stdout.write(
                `${C.R}Compact failed: ${r.error ?? r.reason}${C.r}` +
                `${C.d}${r.consecutiveFailures ? ` (${r.consecutiveFailures} failures)` : ''}${C.r}\n\n`,
              );
              return;
            }
            process.stdout.write(`${C.g}✓ Compacted: ${r.messagesRemoved ?? '?'} msgs removed${C.r}\n\n`);
          } catch (e: any) {
            process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`);
          }
          return;
        case 'dream':
          try { await session.dream({ force: true });
            process.stdout.write(`${C.g}✓ Dream triggered${C.r}\n\n`); }
          catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        default:
          process.stdout.write(`${C.R}Unknown: /${cmd}${C.r}  ${C.d}Type /help${C.r}\n\n`);
          return;
      }
    }

    abortCtrl = new AbortController();
    const stream = session.stream(t, {
      systemPrompt: SYSTEM_PROMPT,
      signal: abortCtrl.signal,
      model: session.model,
      permissionMode: session.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
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

  // ── Readline ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: '', completer, historySize: 1000, terminal: true,
  });
  rl.setPrompt(`${C.c}> ${C.r}`);

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
    try { await processMsg(line); } catch (e: any) {
      if (e.name === 'AbortError') process.stdout.write(`\n${C.y}  ⏹ aborted${C.r}\n`);
      else process.stdout.write(`\n${C.R}  ✕ ${(e as Error).message}${C.r}\n`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`);
    try { await sdk.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
