import { createAgentSdk, loadDefaultActoviqSettings, tool } from 'actoviq-agent-sdk';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';

// ═══════════════════════════════════════════════════════════════════════
//  Interactive ReAct REPL — persistent session, auto-compact
// ═══════════════════════════════════════════════════════════════════════

await loadDefaultActoviqSettings();

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const sdk = await createAgentSdk({
  workDir: WORK_DIR,
  maxToolIterations: 15,
});

// ── Tools ────────────────────────────────────────────────────────────

// Tool definitions aligned with Claude Code naming conventions
// to maximize compatibility with models trained on Anthropic tool formats.

const readFile = tool(
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. You can access any file directly by using this tool.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('The absolute path to the file to read (must be absolute, not relative)'),
    }),
    isReadOnly: () => true,
  },
  async ({ file_path: filePath }) => ({ content: fs.readFileSync(path.resolve(WORK_DIR, filePath), 'utf-8') }),
);

const writeFile = tool(
  {
    name: 'Write',
    description:
      'Writes a file to the local filesystem.\n' +
      'Usage:\n' +
      '- This tool will overwrite the existing file if there is one at the provided path.\n' +
      '- If this is an existing file, you MUST use the Read tool first to read the file\'s contents.\n' +
      '- ALWAYS prefer editing existing files using the Edit tool in the codebase. NEVER write new files unless explicitly required.\n' +
      '- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('The absolute path to the file to write (must be absolute, not relative)'),
      content: z.string().describe('The content to write to the file'),
    }),
  },
  async ({ file_path: filePath, content }) => {
    const fullPath = path.resolve(WORK_DIR, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { written: fullPath };
  },
);

const listDir = tool(
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern. Returns sorted file paths.',
    inputSchema: z.strictObject({
      pattern: z.string().describe('The glob pattern to match files against, e.g. "**/*.ts", "src/**/*.tsx"'),
      path: z.string().optional().describe('The directory to search in. Defaults to the current working directory.'),
    }),
    isReadOnly: () => true,
  },
  async ({ pattern, path: dirPath }) => {
    const searchRoot = path.resolve(WORK_DIR, dirPath ?? '.');
    const results: string[] = [];
    const parts = pattern.split('/');
    function walk(dir: string, depth: number) {
      if (depth >= parts.length) {
        results.push(path.relative(WORK_DIR, dir));
        return;
      }
      const seg = parts[depth]!;
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (seg === '**') {
        walk(dir, depth + 1);
        for (const e of entries) {
          if (e.isDirectory()) walk(path.join(dir, e.name), depth);
        }
      } else {
        for (const e of entries) {
          if (matchSegment(e.name, seg)) walk(path.join(dir, e.name), depth + 1);
        }
      }
    }
    walk(searchRoot, 0);
    return { files: results.slice(0, 200) };
  },
);

const grepSearch = tool(
  {
    name: 'Grep',
    description: 'Search for a pattern in files. Returns matching lines with context.',
    inputSchema: z.strictObject({
      pattern: z.string().describe('The regular expression pattern to search for'),
      path: z.string().optional().describe('File or directory to search in. Defaults to current working directory.'),
      glob: z.string().optional().describe('Glob pattern to filter files, e.g. "*.js", "*.{ts,tsx}"'),
    }),
    isReadOnly: () => true,
  },
  async ({ pattern, path: searchPath, glob }) => {
    const targetPath = path.resolve(WORK_DIR, searchPath ?? '.');
    const ext = glob ? glob.replace(/\*/g, '') : '';
    const files = findFiles(targetPath, ext ? (f) => f.endsWith(ext) : undefined);
    const results: string[] = [];
    let totalMatches = 0;
    for (const f of files) {
      if (results.length >= 10) { results.push(`... and ${files.length - results.length} more files`); break; }
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const regex = new RegExp(pattern, 'g');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            totalMatches++;
            results.push(`${path.relative(WORK_DIR, f)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        }
      } catch {}
    }
    return { matches: results.slice(0, 50), total: totalMatches };
  },
);

const execCommand = tool(
  {
    name: 'Bash',
    description:
      'Executes a given bash command and returns its output.\n' +
      'IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, ' +
      'unless explicitly instructed. Use the dedicated tools (Glob, Grep, Read) instead.',
    inputSchema: z.strictObject({
      command: z.string().describe('The bash command to execute'),
      description: z.string().optional().describe('Clear, concise description of what this command does in active voice.'),
      timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000).'),
    }),
  },
  async ({ command }) => {
    try {
      const output = execSync(command, { cwd: WORK_DIR, encoding: 'utf-8', timeout: 30000 });
      return { stdout: output.trim(), stderr: '', exitCode: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: (err.stdout ?? '').trim(),
        stderr: (err.stderr ?? '').trim() || String(e),
        exitCode: err.status ?? 1,
      };
    }
  },
);

function matchSegment(name: string, pat: string) {
  return new RegExp('^' + pat.replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name);
}

function findFiles(dir: string, filter?: (name: string) => boolean): string[] {
  const results: string[] = [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) { results.push(dir); return results; }
  if (!stat.isDirectory()) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, filter));
    } else if (!filter || filter(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const tools = [readFile, writeFile, listDir, grepSearch, execCommand];

// ── System prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are an interactive CLI agent. Your working directory is ${WORK_DIR}.\n` +
  `Use absolute paths for all file operations.\n` +
  `\n` +
  `# Tools\n` +
  `- Read: reads file contents. You MUST read a file before writing or editing it.\n` +
  `- Write: creates or overwrites files. Prefer editing existing files.\n` +
  `- Glob: find files by pattern (e.g. "src/**/*.tsx").\n` +
  `- Grep: search file contents with regex.\n` +
  `- Bash: execute shell commands. Use dedicated tools (Read, Glob, Grep) instead of find/grep/cat.\n` +
  `\n` +
  `# Guidelines\n` +
  `- Think step by step. Use tools to gather information before making changes.\n` +
  `- Keep responses concise. Default to writing no comments in code.\n` +
  `- NEVER create documentation files (*.md) or README files unless explicitly requested.`;

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
