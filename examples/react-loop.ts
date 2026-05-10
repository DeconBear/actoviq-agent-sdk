import { createAgentSdk, loadDefaultActoviqSettings, createActoviqCoreTools } from 'actoviq-agent-sdk';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';

await loadDefaultActoviqSettings();

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const sdk = await createAgentSdk({
  workDir: WORK_DIR,
  maxToolIterations: 15,
});

const tools = createActoviqCoreTools({ cwd: WORK_DIR });

// ── System prompt — use SDK's builder for Claude Code-aligned guidance ─

const isGit = (() => { try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); return true; } catch { return false; } })();

const SYSTEM_PROMPT = `You are an interactive CLI agent. Your working directory is ${WORK_DIR}. Use absolute paths for all file operations.

<env>
Working directory: ${WORK_DIR}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
Platform: ${process.platform}
Date: ${new Date().toISOString().slice(0, 10)}
</env>

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.

# Doing tasks
- The user will primarily request you to perform software engineering tasks. These may include solving bugs, adding new functionality, refactoring code, explaining code, and more.
- You are highly capable and often allow users to complete ambitious tasks that would otherwise be too complex or take too long. You should defer to user judgement about whether a task is too large to attempt.
- Prefer editing existing files to creating new ones.
- Don't add features, refactor, or introduce abstractions beyond what the task requires.
- Default to writing no comments. Only add one when the WHY is non-obvious.

# Git Safety Protocol
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions.
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending.
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add ."
- NEVER commit changes unless the user explicitly asks you to.

# Other
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- When in doubt, use TodoWrite to track progress.`;

// ── Session ───────────────────────────────────────────────────────────

const session = await sdk.createSession({ title: `ReAct REPL — ${path.basename(WORK_DIR)}` });

// ── UI helpers ────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

let requestCount = 0;
let totalToolCalls = 0;
let currentAbort: AbortController | null = null;
let debugMode = false;

// ── Print intro ───────────────────────────────────────────────────────

console.log('');
console.log(`${c.cyan}${c.bold}╭─ Actoviq ReAct REPL ──────────────────────────────╮${c.reset}`);
console.log(`${c.cyan}│${c.reset}  work dir : ${c.yellow}${WORK_DIR}${c.reset}`);
console.log(`${c.cyan}│${c.reset}  session  : ${c.yellow}${session.id}${c.reset}`);
console.log(`${c.cyan}│${c.reset}  config   : provider=${sdk.config.provider}, model=${sdk.config.model}`);
console.log(`${c.cyan}│${c.reset}            baseURL=${sdk.config.baseURL ?? '(unset)'}`);
console.log(`${c.cyan}│${c.reset}  tools    : ${tools.map((t) => t.name).join(', ')}`);
console.log(`${c.cyan}│${c.reset}  commands : /help /clear /debug /memory /compact /exit`);
console.log(`${c.cyan}├───────────────────────────────────────────────────┤${c.reset}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════
//  Core: process one user message through the ReAct loop
// ═══════════════════════════════════════════════════════════════════════

async function processMessage(input: string): Promise<void> {
  requestCount++;
  currentAbort = new AbortController();

  const activeTools = new Map<string, { name: string; startMs: number }>();
  let iteration = 0;
  let currentText = '';
  let compacted = false;
  let finalText = '';

  const stream = session.stream(input, {
    tools,
    systemPrompt: SYSTEM_PROMPT,
    signal: currentAbort.signal,
  });

  for await (const event of stream) {
    switch (event.type) {
      case 'request.started': {
        iteration = event.iteration;
        currentText = '';
        if (iteration > 1) {
          console.log(`\n${c.dim}── iteration ${iteration} ──${c.reset}`);
        }
        break;
      }

      case 'response.text.delta': {
        if (event.delta) {
          const text = typeof event.delta === 'string'
            ? event.delta
            : (event.delta as { text?: string }).text ?? '';
          process.stdout.write(text);
          currentText += text;
        }
        break;
      }

      case 'response.content': {
        if (event.content.type === 'thinking') {
          const thinking = (event.content as { thinking?: string }).thinking;
          if (thinking) {
            console.log(`\n${c.dim}💭 ${thinking.slice(0, 300)}${thinking.length > 300 ? '...' : ''}${c.reset}`);
          }
        }
        break;
      }

      case 'tool.call': {
        const call = event.call;
        activeTools.set(call.id, { name: call.name, startMs: Date.now() });
        const inputStr = JSON.stringify(call.input);
        console.log(`\n${c.yellow}  ⚡ ${call.name}${c.reset}${c.dim}(${inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr})${c.reset}`);
        if (debugMode) {
          console.log(`${c.dim}     [debug] full input: ${inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr}${c.reset}`);
          console.log(`${c.dim}     [debug] provider: ${call.provider ?? '?'}${c.reset}`);
        }
        break;
      }

      case 'tool.result': {
        totalToolCalls++;
        const info = activeTools.get(event.result.id);
        activeTools.delete(event.result.id);
        const durationMs = info ? Date.now() - info.startMs : event.result.durationMs ?? 0;
        const dur = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
        const marker = event.result.isError ? c.red + '✗' : c.green + '✓';
        const output = typeof event.result.output === 'string'
          ? event.result.output
          : JSON.stringify(event.result.output);
        const truncated = output.length > 300 ? output.slice(0, 300) + '...' : output;
        console.log(`${marker}  ${info?.name ?? 'tool'}${c.reset} ${c.dim}(${dur})${c.reset}`);
        if (truncated) {
          console.log(`${c.dim}     ${truncated.split('\n').join('\n     ')}${c.reset}`);
        }
        break;
      }

      case 'session.compacted': {
        compacted = true;
        break;
      }

      case 'error': {
        console.log(`\n${c.red}  ✕ ${event.error.message}${c.reset}`);
        break;
      }
    }

    if (currentText) finalText = currentText;
  }

  const result = await stream.result;

  if (compacted) {
    console.log(`\n${c.dim}── context compacted ──${c.reset}`);
  }

  if (!finalText && result.text) {
    console.log(`\n${c.green}${result.text}${c.reset}`);
  }

  console.log(`${c.dim}  [${result.requests.length} reqs, ${result.toolCalls.length} tools, stop: ${result.stopReason ?? '?'}]${c.reset}`);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════
//  Slash commands
// ═══════════════════════════════════════════════════════════════════════

async function handleCommand(cmd: string, _args: string): Promise<boolean> {
  switch (cmd) {
    case 'exit':
    case 'quit':
      console.log(`${c.dim}Goodbye.${c.reset}`);
      return false;

    case 'help':
      console.log('');
      console.log(`${c.bold}Commands:${c.reset}`);
      console.log(`  /help      Show this help`);
      console.log(`  /clear     Clear the screen`);
      console.log(`  /memory    Show memory/compact state`);
      console.log(`  /compact   Force compact the session`);
      console.log(`  /exit      Quit the REPL`);
      console.log(`  Ctrl+C     Abort current request, twice to quit`);
      console.log('');
      return true;

    case 'clear':
      console.clear();
      return true;

    case 'memory': {
      try {
        const state = await session.compactState();
        if (state) {
          console.log(`${c.dim}Memory state:${c.reset}`);
          console.log(JSON.stringify(state as unknown as Record<string, unknown>, null, 2));
        } else {
          console.log(`${c.dim}No compact state available.${c.reset}`);
        }
      } catch {
        console.log(`${c.dim}No compact state available.${c.reset}`);
      }
      return true;
    }

    case 'compact': {
      console.log(`${c.dim}Compacting session...${c.reset}`);
      try {
        const r = await session.compact({ force: true });
        const removed = (r as unknown as { messagesRemoved?: number }).messagesRemoved ?? '?';
        console.log(`${c.green}Compacted. Messages removed: ${removed}${c.reset}`);
      } catch (e) {
        console.log(`${c.red}Compact failed: ${(e as Error).message}${c.reset}`);
      }
      return true;
    }

    case 'debug':
      debugMode = !debugMode;
      console.log(`${c.yellow}Debug mode: ${debugMode ? 'ON' : 'OFF'}${c.reset}`);
      if (debugMode) {
        console.log(`${c.dim}  Shows full tool call inputs, provider info, and raw error details.${c.reset}`);
      }
      return true;

    default:
      console.log(`${c.red}Unknown command: /${cmd}. Type /help for available commands.${c.reset}`);
      return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  REPL loop
// ═══════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${c.cyan}> ${c.reset}`,
  terminal: true,
});

let ctrlcCount = 0;
let ctrlcTimer: ReturnType<typeof setTimeout> | null = null;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on('keypress', (_char, key) => {
  if (key && key.name === 'c' && key.ctrl) {
    ctrlcCount++;
    if (ctrlcCount >= 2) {
      console.log(`\n${c.dim}Goodbye.${c.reset}`);
      rl.close();
      return;
    }
    if (ctrlcTimer) clearTimeout(ctrlcTimer);
    ctrlcTimer = setTimeout(() => { ctrlcCount = 0; }, 500);

    if (currentAbort) {
      currentAbort.abort();
      console.log(`\n${c.yellow}  ⏹ Aborting... (Ctrl+C again to exit)${c.reset}`);
      rl.prompt();
    }
  }
});

rl.prompt();

rl.on('line', async (line) => {
  currentAbort = null;
  ctrlcCount = 0;

  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    const keepRunning = await handleCommand(cmd.toLowerCase(), args);
    if (!keepRunning) {
      rl.close();
      return;
    }
  } else {
    try {
      await processMessage(trimmed);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        console.log(`\n${c.yellow}  ⏹ Request aborted.${c.reset}\n`);
      } else {
        console.log(`\n${c.red}  ✕ ${err.message}${c.reset}\n`);
      }
    }
  }

  rl.prompt();
});

rl.on('close', async () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log('');

  try {
    const memState = await session.compactState().catch(() => null);
    if (memState) {
      const ms = memState as unknown as Record<string, unknown>;
      console.log(`${c.dim}Session: ${requestCount} exchanges, ${totalToolCalls} tool calls${c.reset}`);
      if (ms.compactCount) {
        console.log(`${c.dim}Compact count: ${ms.compactCount}${c.reset}`);
      }
    }
  } catch {}

  try { await sdk.close(); } catch {}
  process.exit(0);
});

process.on('SIGWINCH', () => {});
