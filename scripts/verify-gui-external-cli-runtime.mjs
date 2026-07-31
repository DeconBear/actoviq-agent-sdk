import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'output', 'playwright', 'gui-external-cli-runtime');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'hadamard-external-cli-e2e-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'workspace');
const BIN = path.join(TMP, 'bin');
const CONFIG = path.join(HOME, 'settings.json');
const INVOCATION_LOG = path.join(TMP, 'cli-invocations.jsonl');
const ELECTRON_BOOTSTRAP = path.join(TMP, 'electron-e2e-bootstrap.mjs');
const RUNTIMES = [
  {
    runtime: 'claude',
    name: 'Claude Native CLI',
    displayName: 'Claude Code',
    authState: 'authenticated',
    authLabel: 'Authenticated',
    prefix: 'CLI-RUNTIME-OK',
    toolOutput: 'README fixture output',
    historyId: '11111111-2222-4333-8444-555555555555',
  },
  {
    runtime: 'codex',
    name: 'Codex Native CLI',
    displayName: 'Codex CLI',
    authState: 'authenticated',
    authLabel: 'Authenticated',
    prefix: 'CODEX-RUNTIME-OK',
    toolOutput: 'codex-e2e-tool',
    historyId: '22222222-2222-4333-8444-555555555555',
  },
  {
    runtime: 'pi',
    name: 'Pi Native CLI',
    displayName: 'Pi Agent',
    authState: 'unknown',
    authLabel: 'Unknown',
    prefix: 'PI-RUNTIME-OK',
    toolOutput: 'pi-e2e-tool-output',
    historyId: 'pi-history-session',
  },
  {
    runtime: 'codewhale',
    name: 'CodeWhale Native CLI',
    displayName: 'CodeWhale',
    authState: 'authenticated',
    authLabel: 'Authenticated',
    prefix: 'CODEWHALE-RUNTIME-OK',
    toolOutput: 'codewhale-e2e-tool-output',
    historyId: 'codewhale-history-session',
  },
  {
    runtime: 'reasonix',
    name: 'Reasonix Native CLI',
    displayName: 'Reasonix',
    authState: 'unknown',
    authLabel: 'Unknown',
    prefix: 'REASONIX-RUNTIME-OK',
    toolOutput: 'reasonix-e2e-tool-output',
    historyId: 'reasonix-history-session',
  },
  {
    runtime: 'crush',
    name: 'Crush Native CLI',
    displayName: 'Crush',
    authState: 'configured',
    authLabel: 'Configured',
    credentialProvider: 'openai',
    managedProfileId: 'a'.repeat(64),
    prefix: 'CRUSH-RUNTIME-OK',
    toolOutput: 'crush-e2e-tool-output',
    historyId: '66666666-2222-4333-8444-555555555555',
  },
].map((runtime, index) => ({
  ...runtime,
  model: `${runtime.runtime}-e2e`,
  firstPrompt: `${runtime.runtime} first foreground turn`,
  secondPrompt: `${runtime.runtime} second foreground turn`,
  backgroundWait: `${runtime.runtime.toUpperCase()}_BACKGROUND_WAIT`,
  backgroundDone: `${runtime.runtime.toUpperCase()}_BACKGROUND_DONE`,
  historyTitle: `Seeded ${runtime.displayName} native history task`,
  historyAnswer: `Seeded ${runtime.displayName} native history answer`,
  historyFollowUp: `${runtime.runtime} history follow-up`,
  screenshotIndex: String(index + 2).padStart(2, '0'),
}));
const RUNTIME_BY_ID = Object.fromEntries(RUNTIMES.map(runtime => [runtime.runtime, runtime]));
const screenshots = [];
const browserErrors = [];
const verifiedRuntimes = [];
const visualChecks = [];
let verifiedBrowserErrors;
let currentPhase = 'setup';
let app;
let failure;

function electronExecutable() {
  if (process.platform === 'win32') {
    return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(
      ROOT,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    );
  }
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function screenshotBlackTileMetrics(page, buffer) {
  return page.evaluate(async base64 => {
    const source = new Image();
    source.decoding = 'sync';
    await new Promise((resolve, reject) => {
      source.onload = resolve;
      source.onerror = () => reject(new Error('Unable to decode screenshot PNG.'));
      source.src = `data:image/png;base64,${base64}`;
    });
    const scale = Math.min(1, 256 / source.naturalWidth, 256 / source.naturalHeight);
    const width = Math.max(1, Math.round(source.naturalWidth * scale));
    const height = Math.max(1, Math.round(source.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const total = width * height;
    const black = new Uint8Array(total);
    for (let index = 0; index < total; index += 1) {
      const offset = index * 4;
      if (
        pixels[offset] <= 32
        && pixels[offset + 1] <= 32
        && pixels[offset + 2] <= 32
        && pixels[offset + 3] >= 240
      ) black[index] = 1;
    }
    const seen = new Uint8Array(total);
    const stack = new Int32Array(total);
    let largest = { area: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
    for (let start = 0; start < total; start += 1) {
      if (!black[start] || seen[start]) continue;
      let size = 0;
      let top = 0;
      stack[top++] = start;
      seen[start] = 1;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      while (top > 0) {
        const current = stack[--top];
        const x = current % width;
        const y = Math.floor(current / width);
        size += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        const neighbors = [current - 1, current + 1, current - width, current + width];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= total || seen[neighbor] || !black[neighbor]) continue;
          const neighborX = neighbor % width;
          if (Math.abs(neighborX - x) > 1) continue;
          seen[neighbor] = 1;
          stack[top++] = neighbor;
        }
      }
      if (size > largest.area) largest = { area: size, minX, maxX, minY, maxY };
    }
    const regionWidth = largest.area ? largest.maxX - largest.minX + 1 : 0;
    const regionHeight = largest.area ? largest.maxY - largest.minY + 1 : 0;
    const largestFraction = largest.area / total;
    return {
      hasLargeBlackTile: largestFraction >= 0.0075
        && regionWidth / width >= 0.08
        && regionHeight / height >= 0.08,
      largestFraction,
      regionWidthFraction: regionWidth / width,
      regionHeightFraction: regionHeight / height,
    };
  }, buffer.toString('base64'));
}

async function settleScreenshot(page, repaint = false) {
  await page.bringToFront();
  if (repaint) {
    await page.evaluate(async () => {
      const previousTransform = document.body.style.transform;
      document.body.style.transform = 'translateZ(0)';
      void document.body.offsetHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.body.style.transform = previousTransform;
    });
  }
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(100);
}

async function shot(page, name) {
  const target = path.join(ARTIFACTS, name);
  let lastMetrics;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await settleScreenshot(page, attempt > 1);
    const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
    lastMetrics = await screenshotBlackTileMetrics(page, buffer);
    if (!lastMetrics.hasLargeBlackTile) {
      await writeFile(target, buffer);
      screenshots.push(target);
      visualChecks.push({
        name,
        attempts: attempt,
        largestBlackRegionFraction: lastMetrics.largestFraction,
      });
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Large black screenshot tile remained in ${name}: ${JSON.stringify(lastMetrics)}`);
}

async function api(page, requestPath, init = {}) {
  return page.evaluate(async ({ requestPath, init }) => {
    const response = await fetch(requestPath, {
      ...init,
      headers: {
        'x-hadamard-token': window.__HADAMARD_TOKEN__,
        ...(init.headers || {}),
      },
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { requestPath, init });
}

async function apiState(page) {
  const response = await api(page, '/api/state');
  assert.equal(response.status, 200);
  return response.body;
}

async function openModelsSettings(page) {
  const modal = page.locator('#settingsModal');
  if (await modal.evaluate(node => node.classList.contains('hidden'))) {
    await page.locator('#settingsBtn').click();
  }
  await modal.waitFor({ state: 'visible' });
  await page.locator('[data-settings-tab="models"]').click();
  await page.locator('[data-settings-panel="models"]').waitFor({ state: 'visible' });
}

async function closeSettings(page) {
  const modal = page.locator('#settingsModal');
  if (!(await modal.evaluate(node => node.classList.contains('hidden')))) {
    await page.locator('#backToAppBtn').click();
  }
  await modal.waitFor({ state: 'hidden' });
}

async function send(page, text) {
  await page.locator('#promptInput').fill(text);
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/send') && response.request().method() === 'POST');
  await page.locator('#sendBtn').click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `send failed for ${text}`);
  await page.locator('#statusbar').filter({ hasText: /^Ready/ }).waitFor();
}

async function readInvocations() {
  try {
    return (await readFile(INVOCATION_LOG, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function installFakeClis() {
  await mkdir(BIN, { recursive: true });
  const claudeEntry = path.join(BIN, 'fake-claude.mjs');
  const codexEntry = path.join(BIN, 'fake-codex.mjs');
  const piEntry = path.join(BIN, 'fake-pi.mjs');
  const codewhaleEntry = path.join(BIN, 'fake-codewhale.mjs');
  const reasonixEntry = path.join(BIN, 'fake-reasonix.mjs');
  const crushEntry = path.join(BIN, 'fake-crush.mjs');
  await writeFile(claudeEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find(value => value.startsWith(name + '='));
  return inline ? inline.slice(name.length + 1) : undefined;
};
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (argv.includes('--version')) {
  process.stdout.write('claude 2.1.0\\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'oauth',
    apiProvider: 'firstParty',
  }, null, 2) + '\\n');
  process.exit(0);
}

const delimiter = argv.indexOf('--');
const prompt = delimiter >= 0 ? (argv[delimiter + 1] || '') : '';
const resumeId = flag('--resume');
const sessionId = resumeId || flag('--session-id') || 'e2e-native-session';
appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
  runtime: 'claude',
  argv,
  prompt,
  sessionId,
  resumed: Boolean(resumeId),
  cwd: process.cwd(),
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
}) + '\\n');

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: process.cwd(),
  model: 'claude-e2e',
  tools: ['Read'],
  mcp_servers: [],
  slash_commands: [],
  agents: [],
  skills: [],
  plugins: [],
});

if (prompt === 'CLAUDE_BACKGROUND_WAIT') {
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
  setTimeout(() => process.exit(2), 30_000);
} else {
  const text = 'CLI-RUNTIME-OK:' + (resumeId ? 'resume:' : 'new:') + prompt;
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-e2e', name: 'Read', input: { file_path: 'README.md' } }],
    },
  });
  emit({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-e2e', content: 'README fixture output' }],
    },
  });
  const middle = Math.max(1, Math.floor(text.length / 2));
  for (const delta of [text.slice(0, middle), text.slice(middle)]) {
    emit({
      type: 'stream_event',
      session_id: sessionId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta },
      },
    });
  }
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: text,
    stop_reason: 'end_turn',
    duration_ms: 12,
    total_cost_usd: 0,
    num_turns: 1,
  });
}
`, 'utf8');
  await writeFile(codexEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (argv.includes('--version')) {
  process.stdout.write('codex 0.113.0\\n');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}

const delimiter = argv.indexOf('--');
const positionals = delimiter >= 0 ? argv.slice(delimiter + 1) : [];
const resumed = argv[1] === 'resume';
const sessionId = resumed ? (positionals[0] || 'e2e-codex-session') : 'e2e-codex-session';
const prompt = resumed ? (positionals[1] || '') : (positionals[0] || '');
appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
  runtime: 'codex',
  argv,
  prompt,
  sessionId,
  resumed,
  cwd: process.cwd(),
  hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
}) + '\\n');

emit({ type: 'thread.started', thread_id: sessionId });
emit({ type: 'turn.started' });
if (prompt === 'CODEX_BACKGROUND_WAIT') {
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
  setTimeout(() => process.exit(2), 30_000);
} else {
  const text = 'CODEX-RUNTIME-OK:' + (resumed ? 'resume:' : 'new:') + prompt;
  emit({
    type: 'item.started',
    item: {
      id: 'codex-tool-e2e',
      type: 'command_execution',
      command: 'printf codex-e2e-tool',
      status: 'in_progress',
    },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'codex-tool-e2e',
      type: 'command_execution',
      command: 'printf codex-e2e-tool',
      aggregated_output: 'codex-e2e-tool',
      exit_code: 0,
      status: 'completed',
    },
  });
  emit({
    type: 'item.started',
    item: { id: 'codex-message-e2e', type: 'agent_message', text: '' },
  });
  emit({
    type: 'item.completed',
    item: { id: 'codex-message-e2e', type: 'agent_message', text },
  });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 8,
      cached_input_tokens: 0,
      output_tokens: text.length,
      reasoning_output_tokens: 0,
    },
  });
}
`, 'utf8');

  await writeFile(piEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('pi 0.80.6\\n');
  process.exit(0);
}
if (argv.includes('--offline') && argv.includes('--list-models')) {
  process.stdout.write('openai/pi-e2e\\n');
  process.exit(0);
}
const flag = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const resumed = Boolean(flag('--session'));
const sessionId = flag('--session') || flag('--session-id') || 'pi-e2e-session';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    emit({
      id: request.id,
      type: 'response',
      success: true,
      data: { sessionId, cwd: process.cwd(), model: flag('--model') || 'pi-e2e' },
    });
    continue;
  }
  if (request.type === 'abort') {
    emit({ id: request.id, type: 'response', success: true });
    emit({ type: 'agent_end' });
    process.exit(0);
  }
  if (request.type !== 'prompt') continue;
  const prompt = typeof request.message === 'string' ? request.message : '';
  appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
    runtime: 'pi', argv, prompt, sessionId, resumed, cwd: process.cwd(),
    hasProviderKey: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
  }) + '\\n');
  emit({ id: request.id, type: 'response', success: true });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  if (prompt === 'PI_BACKGROUND_WAIT') continue;
  const text = 'PI-RUNTIME-OK:' + (resumed ? 'resume:' : 'new:') + prompt;
  emit({
    type: 'tool_execution_start',
    toolCallId: 'pi-tool-e2e',
    toolName: 'read',
    args: { path: 'README.md' },
  });
  emit({
    type: 'tool_execution_end',
    toolCallId: 'pi-tool-e2e',
    toolName: 'read',
    result: 'pi-e2e-tool-output',
    isError: false,
  });
  const middle = Math.max(1, Math.floor(text.length / 2));
  for (const delta of [text.slice(0, middle), text.slice(middle)]) {
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
    });
  }
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: flag('--model') || 'pi-e2e',
      usage: { input: 8, output: text.length, cost: { total: 0 } },
      stopReason: 'stop',
    },
  });
  emit({ type: 'turn_end' });
  emit({ type: 'agent_end', messages: [], willRetry: false });
}
`, 'utf8');

  await writeFile(codewhaleEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codewhale 0.8.65\\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write('Active provider: openai\\nCredential source: config\\n');
  process.exit(0);
}
const boundary = argv.lastIndexOf('--');
const prompt = boundary >= 0 ? argv[boundary + 1] || '' : '';
const resumeArgument = argv.find(argument => argument.startsWith('--resume='));
const resumedSessionId = resumeArgument && resumeArgument.slice('--resume='.length);
const resumed = Boolean(resumedSessionId);
const sessionId = resumedSessionId || 'codewhale-e2e-session';
const text = 'CODEWHALE-RUNTIME-OK:' + (resumed ? 'resume:' : 'new:') + prompt;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const redactedIdentifierForLog = identifier => {
  const bytes = Buffer.from(identifier, 'utf8');
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  hash = BigInt.asUintN(64, (hash ^ BigInt(bytes.length)) * 0x100000001b3n);
  return '<redacted:' + hash.toString(16).padStart(16, '0') + '>';
};

appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
  runtime: 'codewhale', argv, prompt, sessionId, resumed, cwd: process.cwd(),
  hasProviderKey: Boolean(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
}) + '\\n');
if (process.env.CODEWHALE_HOME) {
  const sessionsRoot = path.join(process.env.CODEWHALE_HOME, 'sessions');
  const now = new Date().toISOString();
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(path.join(sessionsRoot, sessionId + '.json'), JSON.stringify({
    schema_version: 1,
    metadata: {
      id: sessionId,
      title: 'CodeWhale E2E session',
      created_at: now,
      updated_at: now,
      message_count: 2,
      total_tokens: text.length + 4,
      model: 'codewhale-e2e',
      workspace: process.cwd(),
      cost: {},
      cumulative_turn_secs: 1,
    },
    messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
  }), 'utf8');
}
if (prompt === 'CODEWHALE_BACKGROUND_WAIT') {
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
  setTimeout(() => process.exit(2), 30_000);
} else {
  const middle = Math.max(1, Math.floor(text.length / 2));
  emit({ type: 'content', content: text.slice(0, middle) });
  emit({ type: 'content', content: text.slice(middle) });
  emit({ type: 'tool_use', id: 'codewhale-tool-e2e', name: 'read_file', input: { path: 'README.md' } });
  emit({ type: 'tool_result', id: 'codewhale-tool-e2e', output: 'codewhale-e2e-tool-output', status: 'success' });
  emit({
    type: 'metadata',
    meta: {
      model: 'codewhale-e2e',
      input_tokens: 4,
      output_tokens: text.length,
      session_id: redactedIdentifierForLog(sessionId),
      workspace: process.cwd(),
      message_count: 2,
      status: 'completed',
    },
  });
  emit({ type: 'done' });
}
`, 'utf8');

  await writeFile(reasonixEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('reasonix 1.17.12\\n');
  process.exit(0);
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = 'reasonix-e2e-session';
let resumed = false;
let turnCount = 0;

for await (const line of input) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (record.method === 'initialize') {
    emit({
      jsonrpc: '2.0',
      id: record.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    continue;
  }
  if (record.method === 'session/new') {
    resumed = false;
    emit({ jsonrpc: '2.0', id: record.id, result: { sessionId, configOptions: [] } });
    continue;
  }
  if (record.method === 'session/load') {
    sessionId = record.params && record.params.sessionId || sessionId;
    resumed = true;
    emit({ jsonrpc: '2.0', id: record.id, result: { sessionId, configOptions: [] } });
    continue;
  }
  if (record.method === 'session/set_config_option') {
    emit({ jsonrpc: '2.0', id: record.id, result: {} });
    continue;
  }
  if (record.method === 'session/cancel') process.exit(0);
  if (record.method !== 'session/prompt') continue;
  const block = Array.isArray(record.params && record.params.prompt) ? record.params.prompt[0] : undefined;
  const prompt = block && typeof block.text === 'string' ? block.text : '';
  const currentResumed = resumed || turnCount > 0;
  appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
    runtime: 'reasonix', argv, prompt, sessionId, resumed: currentResumed, cwd: process.cwd(),
    hasProviderKey: Boolean(process.env.DEEPSEEK_API_KEY),
  }) + '\\n');
  if (prompt === 'REASONIX_BACKGROUND_WAIT') continue;
  const text = 'REASONIX-RUNTIME-OK:' + (currentResumed ? 'resume:' : 'new:') + prompt;
  emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'reasonix-tool-e2e',
        title: 'read_file',
        kind: 'read',
        rawInput: { path: 'README.md' },
      },
    },
  });
  emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'reasonix-tool-e2e',
        status: 'completed',
        content: [{ type: 'text', text: 'reasonix-e2e-tool-output' }],
      },
    },
  });
  const middle = Math.max(1, Math.floor(text.length / 2));
  for (const chunk of [text.slice(0, middle), text.slice(middle)]) {
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
      },
    });
  }
  emit({ jsonrpc: '2.0', id: record.id, result: { stopReason: 'end_turn' } });
  turnCount += 1;
}
`, 'utf8');

  await writeFile(crushEntry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import process from 'node:process';

const argv = process.argv.slice(2);
const historyId = process.env.HADAMARD_E2E_CRUSH_HISTORY_ID;
const historyTitle = process.env.HADAMARD_E2E_CRUSH_HISTORY_TITLE;
const historyAnswer = process.env.HADAMARD_E2E_CRUSH_HISTORY_ANSWER;
if (argv.includes('--version')) {
  process.stdout.write('crush 0.84.1\\n');
  process.exit(0);
}
if (argv[0] === 'models') {
  process.stdout.write('openai/crush-e2e\\n');
  process.exit(0);
}
if (argv[0] === 'session' && argv[1] === 'list' && argv.includes('--json')) {
  process.stdout.write(JSON.stringify([{
    uuid: historyId,
    title: historyTitle,
    created: '2026-07-14T08:00:00.000Z',
    modified: '2026-07-14T08:00:02.000Z',
  }]) + '\\n');
  process.exit(0);
}
if (argv[0] === 'session' && argv[1] === 'show' && argv[2] === historyId && argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    meta: {
      uuid: historyId,
      title: historyTitle,
      created: '2026-07-14T08:00:00.000Z',
      modified: '2026-07-14T08:00:02.000Z',
    },
    messages: [
      {
        role: 'user',
        created: '2026-07-14T08:00:01.000Z',
        parts: [{ type: 'text', text: historyTitle }],
      },
      {
        role: 'assistant',
        created: '2026-07-14T08:00:02.000Z',
        model: 'crush-e2e',
        parts: [
          { type: 'text', text: historyAnswer },
          { type: 'tool_call', tool_call_id: 'history-crush-tool', name: 'read_file', input: '{"path":"README.md"}' },
          { type: 'tool_result', tool_call_id: 'history-crush-tool', name: 'read_file', content: 'history-crush-tool-output' },
        ],
      },
    ],
  }) + '\\n');
  process.exit(0);
}

const hostIndex = argv.indexOf('--host');
if (argv[0] !== 'server' || hostIndex < 0 || !argv[hostIndex + 1]) {
  process.stderr.write('fake crush requires server --host <local socket>\\n');
  process.exit(2);
}
const serverHost = argv[hostIndex + 1];
const socketPath = serverHost.startsWith('npipe:////./pipe/')
  ? '\\\\\\\\.\\\\pipe\\\\' + serverHost.slice('npipe:////./pipe/'.length)
  : serverHost.startsWith('unix://')
    ? serverHost.slice('unix://'.length)
    : '';
if (!socketPath) process.exit(2);

const subscribers = new Set();
const liveSessionId = '77777777-2222-4333-8444-555555555555';
let currentSessionId = '';
let resumed = false;

function sendJson(response, value, statusCode = 200) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}
function sendEmpty(response, statusCode = 200) {
  response.writeHead(statusCode, { 'content-length': '0' });
  response.end();
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
    });
  });
}
function emit(kind, data) {
  const frame = 'data: ' + JSON.stringify({ type: kind, payload: { type: 'updated', payload: data } }) + '\\n\\n';
  for (const response of subscribers) response.write(frame);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = url.pathname;
  if (request.method === 'GET' && pathname === '/v1/health') return sendEmpty(response);
  if (request.method === 'POST' && pathname === '/v1/workspaces') {
    await readJson(request);
    return sendJson(response, { id: 'workspace-1' });
  }
  if (request.method === 'POST' && (pathname.endsWith('/config/set') || pathname.endsWith('/config/provider-key') || pathname.endsWith('/config/model'))) {
    await readJson(request);
    return sendEmpty(response);
  }
  if (request.method === 'POST' && pathname.endsWith('/sessions')) {
    currentSessionId = liveSessionId;
    resumed = false;
    return sendJson(response, { id: currentSessionId });
  }
  const existingSession = pathname.match(/\\/sessions\\/([^/]+)$/u);
  if (request.method === 'GET' && existingSession) {
    currentSessionId = decodeURIComponent(existingSession[1]);
    resumed = true;
    return sendJson(response, { id: currentSessionId });
  }
  if (request.method === 'POST' && pathname.endsWith('/permissions/skip')) {
    await readJson(request);
    return sendEmpty(response);
  }
  if (request.method === 'POST' && pathname.endsWith('/agent/init')) return sendEmpty(response);
  if (request.method === 'GET' && pathname.endsWith('/agent')) return sendJson(response, { is_ready: true });
  if (request.method === 'GET' && pathname.endsWith('/events')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.flushHeaders();
    subscribers.add(response);
    response.once('close', () => subscribers.delete(response));
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/current-session')) {
    const body = await readJson(request);
    currentSessionId = typeof body.session_id === 'string' ? body.session_id : currentSessionId;
    return sendEmpty(response);
  }
  if (request.method === 'POST' && pathname.endsWith('/agent')) {
    const body = await readJson(request);
    const sessionId = body.session_id || currentSessionId;
    const prompt = body.prompt || '';
    const currentResumed = resumed;
    resumed = true;
    appendFileSync(process.env.HADAMARD_E2E_INVOCATIONS, JSON.stringify({
      runtime: 'crush', argv, prompt, sessionId, resumed: currentResumed, cwd: process.cwd(),
      hasProviderKey: Boolean(process.env.CRUSH_OPENAI_API_KEY || process.env.CRUSH_ANTHROPIC_API_KEY),
    }) + '\\n');
    sendEmpty(response, 202);
    if (prompt === 'CRUSH_BACKGROUND_WAIT') return;
    const text = 'CRUSH-RUNTIME-OK:' + (currentResumed ? 'resume:' : 'new:') + prompt;
    queueMicrotask(() => {
      emit('message', {
        id: 'crush-assistant-e2e',
        role: 'assistant',
        session_id: sessionId,
        run_id: body.run_id,
        parts: [
          { type: 'text', data: { text } },
          { type: 'tool_call', data: { id: 'crush-tool-e2e', name: 'read_file', input: '{"path":"README.md"}', finished: true } },
          { type: 'tool_result', data: { tool_call_id: 'crush-tool-e2e', content: 'crush-e2e-tool-output', is_error: false } },
        ],
      });
      emit('run_complete', { session_id: sessionId, run_id: body.run_id, text });
    });
    return;
  }
  if (request.method === 'POST' && pathname.includes('/agent/sessions/') && pathname.endsWith('/cancel')) return sendEmpty(response);
  if (request.method === 'POST' && pathname === '/v1/control') {
    sendEmpty(response);
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  sendJson(response, { error: 'unhandled ' + request.method + ' ' + pathname }, 404);
});
server.listen(socketPath);
`, 'utf8');

  if (process.platform === 'win32') {
    await Promise.all([
      ...RUNTIMES.map(runtime => writeFile(
        path.join(BIN, `${runtime.runtime}.cmd`),
        `@echo off\r\nnode "%~dp0\\fake-${runtime.runtime}.mjs" %*\r\n`,
        'utf8',
      )),
    ]);
  } else {
    await Promise.all([
      ...RUNTIMES.map(runtime => writeFile(
        path.join(BIN, runtime.runtime),
        `#!/bin/sh\nexec node "$(dirname "$0")/fake-${runtime.runtime}.mjs" "$@"\n`,
        'utf8',
      )),
    ]);
    await Promise.all([
      ...RUNTIMES.map(runtime => chmod(path.join(BIN, runtime.runtime), 0o755)),
      chmod(claudeEntry, 0o755),
      chmod(codexEntry, 0o755),
      chmod(piEntry, 0o755),
      chmod(codewhaleEntry, 0o755),
      chmod(reasonixEntry, 0o755),
      chmod(crushEntry, 0o755),
    ]);
  }
}

async function seedNativeHistory() {
  const claude = RUNTIME_BY_ID.claude;
  const codex = RUNTIME_BY_ID.codex;
  const pi = RUNTIME_BY_ID.pi;
  const codewhale = RUNTIME_BY_ID.codewhale;
  const reasonix = RUNTIME_BY_ID.reasonix;
  const crush = RUNTIME_BY_ID.crush;
  const claudePath = path.join(HOME, '.claude', 'projects', 'e2e', `${claude.historyId}.jsonl`);
  const codexPath = path.join(
    HOME,
    '.codex',
    'sessions',
    '2026',
    '07',
    '14',
    `rollout-${codex.historyId}.jsonl`,
  );
  const piPath = path.join(
    HOME,
    '.pi',
    'agent',
    'sessions',
    'e2e',
    `2026-07-14_${pi.historyId}.jsonl`,
  );
  const codewhalePath = path.join(
    HOME,
    '.codewhale',
    'sessions',
    `${codewhale.historyId}.json`,
  );
  const reasonixRoot = path.join(HOME, '.reasonix', 'sessions');
  const reasonixPath = path.join(reasonixRoot, `${reasonix.historyId}.jsonl`);
  const crushManagedProfileData = path.join(
    HOME,
    'external-cli-profiles',
    'crush',
    crush.managedProfileId,
    'data',
  );
  await Promise.all([
    mkdir(path.dirname(claudePath), { recursive: true }),
    mkdir(path.dirname(codexPath), { recursive: true }),
    mkdir(path.dirname(piPath), { recursive: true }),
    mkdir(path.dirname(codewhalePath), { recursive: true }),
    mkdir(reasonixRoot, { recursive: true }),
    mkdir(crushManagedProfileData, { recursive: true }),
  ]);
  await writeFile(claudePath, [
    JSON.stringify({
      type: 'user',
      sessionId: claude.historyId,
      cwd: WORK,
      timestamp: '2026-07-13T08:00:00.000Z',
      message: { role: 'user', content: claude.historyTitle },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: claude.historyId,
      cwd: WORK,
      timestamp: '2026-07-13T08:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-e2e',
        content: [{ type: 'text', text: claude.historyAnswer }],
      },
    }),
  ].join('\n'), 'utf8');
  await writeFile(codexPath, [
    JSON.stringify({
      timestamp: '2026-07-14T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: codex.historyId, cwd: WORK },
    }),
    JSON.stringify({
      timestamp: '2026-07-14T08:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'codex-e2e', cwd: WORK },
    }),
    JSON.stringify({
      timestamp: '2026-07-14T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: codex.historyTitle }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-14T08:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: codex.historyAnswer }],
      },
    }),
  ].join('\n'), 'utf8');
  await writeFile(piPath, [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: pi.historyId,
      timestamp: '2026-07-14T08:10:00.000Z',
      cwd: WORK,
    }),
    JSON.stringify({
      type: 'message',
      id: 'pi-history-user',
      parentId: null,
      timestamp: '2026-07-14T08:10:01.000Z',
      message: { role: 'user', content: pi.historyTitle },
    }),
    JSON.stringify({
      type: 'message',
      id: 'pi-history-answer',
      parentId: 'pi-history-user',
      timestamp: '2026-07-14T08:10:02.000Z',
      message: {
        role: 'assistant',
        model: 'pi-e2e',
        content: [{ type: 'text', text: pi.historyAnswer }],
      },
    }),
    JSON.stringify({
      type: 'session_info',
      id: 'pi-history-title',
      parentId: 'pi-history-answer',
      timestamp: '2026-07-14T08:10:03.000Z',
      name: pi.historyTitle,
    }),
  ].join('\n'), 'utf8');
  await writeFile(codewhalePath, JSON.stringify({
    schema_version: 1,
    metadata: {
      id: codewhale.historyId,
      title: codewhale.historyTitle,
      created_at: '2026-07-14T08:20:00.000Z',
      updated_at: '2026-07-14T08:20:02.000Z',
      message_count: 2,
      total_tokens: 12,
      model: 'codewhale-e2e',
      workspace: WORK,
      cost: {},
      cumulative_turn_secs: 1,
    },
    messages: [
      { role: 'user', content: [{ type: 'text', text: codewhale.historyTitle }] },
      { role: 'assistant', content: [{ type: 'text', text: codewhale.historyAnswer }] },
    ],
  }), 'utf8');
  await writeFile(reasonixPath, [
    JSON.stringify({
      role: 'user',
      content: reasonix.historyTitle,
      timestamp: '2026-07-14T08:30:01.000Z',
    }),
    JSON.stringify({
      role: 'assistant',
      content: reasonix.historyAnswer,
      timestamp: '2026-07-14T08:30:02.000Z',
    }),
  ].join('\n'), 'utf8');
  await writeFile(path.join(reasonixRoot, `${reasonix.historyId}.acp.json`), JSON.stringify({
    sessionId: reasonix.historyId,
    cwd: WORK,
    model: 'reasonix-e2e',
    title: reasonix.historyTitle,
    createdAt: '2026-07-14T08:30:00.000Z',
    updatedAt: '2026-07-14T08:30:02.000Z',
  }), 'utf8');
}

async function closeApplication() {
  if (!app) return;
  let closed = false;
  await Promise.race([
    app.close().then(() => { closed = true; }),
    new Promise(resolve => setTimeout(resolve, 8_000)),
  ]);
  if (!closed) app.process().kill('SIGKILL');
}

try {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await Promise.all([
    mkdir(ARTIFACTS, { recursive: true }),
    mkdir(HOME, { recursive: true }),
    mkdir(WORK, { recursive: true }),
  ]);
  await installFakeClis();
  await seedNativeHistory();
  await Promise.all([
    writeFile(CONFIG, JSON.stringify({ env: {} }, null, 2), 'utf8'),
    writeFile(ELECTRON_BOOTSTRAP, [
      "import { app } from 'electron';",
      `const entryPath = ${JSON.stringify(path.join(ROOT, 'dist', 'src', 'gui', 'electronMain.js'))};`,
      `const bootstrapPath = ${JSON.stringify(ELECTRON_BOOTSTRAP)};`,
      'const bootstrapIndex = process.argv.findIndex(value => value.toLowerCase() === bootstrapPath.toLowerCase());',
      "if (bootstrapIndex < 0) throw new Error('Electron E2E bootstrap argument was not found.');",
      'process.argv.splice(1, bootstrapIndex, entryPath);',
      'app.disableHardwareAcceleration();',
      `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist', 'src', 'gui', 'electronMain.js')).href)});`,
      '',
    ].join('\n'), 'utf8'),
    writeFile(path.join(HOME, 'bridge-configs.json'), JSON.stringify({
      configs: RUNTIMES.map(runtime => ({
        name: runtime.name,
        runtime: runtime.runtime,
        execution: 'cli',
        authSource: 'native',
        provider: runtime.runtime === 'claude'
          ? 'anthropic'
          : runtime.runtime === 'reasonix'
            ? 'deepseek'
            : 'openai',
        ...(runtime.credentialProvider
          ? { credentialProvider: runtime.credentialProvider }
          : {}),
        model: runtime.model,
      })),
    }, null, 2), 'utf8'),
  ]);

  const guiPort = await freePort();
  const env = {
    ...process.env,
    HADAMARD_HOME: HOME,
    HADAMARD_E2E_INVOCATIONS: INVOCATION_LOG,
    HADAMARD_E2E_CRUSH_HISTORY_ID: RUNTIME_BY_ID.crush.historyId,
    HADAMARD_E2E_CRUSH_HISTORY_TITLE: RUNTIME_BY_ID.crush.historyTitle,
    HADAMARD_E2E_CRUSH_HISTORY_ANSWER: RUNTIME_BY_ID.crush.historyAnswer,
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    PI_CODING_AGENT_SESSION_DIR: path.join(HOME, '.pi', 'agent', 'sessions'),
    CODEWHALE_HOME: path.join(HOME, '.codewhale'),
    REASONIX_HOME: path.join(HOME, '.reasonix'),
    REASONIX_STATE_HOME: path.join(HOME, '.reasonix'),
    NODE_ENV: 'test',
    PATH: `${BIN}${path.delimiter}${process.env.PATH || ''}`,
  };
  // Native-auth mode is the behavior under test. Keep the parent developer
  // shell's provider credentials out of the deterministic child process.
  delete env.HADAMARD_API_KEY;
  delete env.HADAMARD_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CRUSH_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronExecutable(),
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      ELECTRON_BOOTSTRAP,
      WORK,
      '--config', CONFIG,
      '--port', String(guiPort),
      '--permission-mode', 'bypassPermissions',
    ],
    cwd: ROOT,
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.getElementById('overviewBody')?.children.length);
  await page.locator('#newSession').evaluate(button => button.click());
  await page.locator('#projectConversation').waitFor({ state: 'visible' });

  currentPhase = 'config-and-auth';
  await openModelsSettings(page);
  await page.locator('#externalCliAuthRefresh').click();
  await page.locator('#externalCliAuthStatus').filter({ hasText: 'Reusable native login:' }).waitFor();
  const authResponse = await api(page, '/api/external-cli/auth');
  assert.equal(authResponse.status, 200);
  assert.deepEqual(
    Object.fromEntries(authResponse.body.runtimes.map(item => [item.runtime, item.state])),
    Object.fromEntries(RUNTIMES.map(runtime => [runtime.runtime, runtime.authState])),
  );
  const runtimeList = page.locator('#runtimeDiscoveryList');
  for (const runtime of RUNTIMES) {
    const runtimeCard = runtimeList.locator('.settings-card').filter({
      has: page.locator('strong', { hasText: new RegExp(`^${runtime.displayName}$`, 'u') }),
    });
    await runtimeCard.filter({ hasText: runtime.authLabel }).waitFor();
    const configCard = page.locator('#bridgeConfigsList .settings-card').filter({ hasText: runtime.name });
    await configCard.filter({ hasText: 'External CLI' }).filter({ hasText: 'reuse CLI login' }).waitFor();
  }
  assert.equal((await runtimeList.textContent()).includes('key configured'), false);
  await shot(page, '01-six-runtime-config-and-auth.png');

  for (const runtime of RUNTIMES) {
    currentPhase = `${runtime.runtime}:activate-and-foreground`;
    await closeSettings(page);
    await page.locator('#modelPickerBtn').click();
    const pickerItem = page.locator('#modelPickerItems .picker-item').filter({
      has: page.locator('.picker-item-label', { hasText: new RegExp(`^${runtime.name}$`, 'u') }),
    });
    await pickerItem.waitFor();
    const [activationResponse] = await Promise.all([
      page.waitForResponse(response =>
        response.url().endsWith('/api/agent/activate') && response.request().method() === 'POST'),
      pickerItem.click(),
    ]);
    const activationPayload = await activationResponse.json();
    assert.equal(activationResponse.status(), 200, JSON.stringify(activationPayload));
    assert.equal(activationPayload.bridgeState?.activeConfig?.name, runtime.name);
    await pickerItem.evaluate(element => {
      if (!element.classList.contains('selected')) {
        throw new Error('Selected runtime is not marked active in the model picker');
      }
    });
    await page.locator('#modelPickerBtn').click();
    await page.locator('#credentialHint').waitFor({ state: 'hidden' });
    await page.locator('#modelPickerBtn').filter({ hasText: runtime.name }).waitFor();

    await send(page, runtime.firstPrompt);
    await page.locator('#transcript')
      .filter({ hasText: `${runtime.prefix}:new:${runtime.firstPrompt}` })
      .waitFor();
    const toolCard = page.locator('#transcript .tool-card').last();
    await toolCard.waitFor();
    await toolCard.locator('header').click();
    await toolCard.filter({ hasText: runtime.toolOutput }).waitFor();
    await send(page, runtime.secondPrompt);
    await page.locator('#transcript')
      .filter({ hasText: `${runtime.prefix}:resume:${runtime.secondPrompt}` })
      .waitFor();
    const foregroundInvocations = (await readInvocations())
      .filter(item => item.runtime === runtime.runtime)
      .filter(item => item.prompt === runtime.firstPrompt || item.prompt === runtime.secondPrompt);
    assert.equal(foregroundInvocations.length, 2, runtime.runtime);
    assert.equal(foregroundInvocations[0].resumed, false, runtime.runtime);
    assert.equal(foregroundInvocations[1].resumed, true, runtime.runtime);
    assert.equal(foregroundInvocations[1].sessionId, foregroundInvocations[0].sessionId, runtime.runtime);
    assert.equal(foregroundInvocations[0].cwd, WORK, runtime.runtime);
    assert.equal(
      foregroundInvocations[0].hasAnthropicKey
        ?? foregroundInvocations[0].hasOpenAIKey
        ?? foregroundInvocations[0].hasProviderKey,
      false,
      runtime.runtime,
    );
    const firstState = await apiState(page);
    assert.equal(firstState.bridgeState.activeConfig.runtime, runtime.runtime);
    assert.equal(firstState.bridgeState.activeConfig.execution, 'cli');
    assert(firstState.bridgeState.activeConfig.nativeSessionId);
    await shot(page, `${runtime.screenshotIndex}-${runtime.runtime}-foreground-stream-and-tools.png`);

    currentPhase = `${runtime.runtime}:background-runs`;
    await openModelsSettings(page);
    await page.locator('#externalCliRunConfig').selectOption(runtime.name);
    await page.locator('#externalCliRunPrompt').fill(runtime.backgroundWait);
    await page.locator('#externalCliRunStart').click();
    const activeRun = page.locator('#externalCliRunsList .settings-card')
      .filter({ hasText: runtime.name })
      .filter({ hasText: 'running' })
      .first();
    await activeRun.waitFor();
    await activeRun.getByRole('button', { name: 'Stop' }).click();
    await page.locator('#externalCliRunsList .settings-card')
      .filter({ hasText: runtime.name })
      .filter({ hasText: 'aborted' })
      .waitFor();

    await page.locator('#externalCliRunPrompt').fill(runtime.backgroundDone);
    await page.locator('#externalCliRunStart').click();
    const completedRun = page.locator('#externalCliRunsList .settings-card')
      .filter({ hasText: runtime.name })
      .filter({ hasText: runtime.backgroundDone })
      .filter({ hasText: 'completed' })
      .first();
    await completedRun.waitFor();
    await completedRun.getByRole('button', { name: 'View output' }).click();
    await page.locator('#surfaceDrawer').waitFor({ state: 'visible' });
    const resultCard = page.locator('#surfaceList .external-cli-run-result');
    const matchingResultCard = resultCard
      .filter({ hasText: `${runtime.prefix}:resume:${runtime.backgroundDone}` })
      .filter({ hasText: '1 turn' });
    await matchingResultCard.waitFor();
    if (runtime.runtime !== 'reasonix') {
      await matchingResultCard.filter({ hasText: 'exit 0' }).waitFor();
    }
    const rawTrace = page.locator('#surfaceList details.runtime-trace');
    await rawTrace.waitFor();
    assert.equal(await rawTrace.evaluate(node => node.open), false);
    if (runtime.runtime === 'claude') {
      await rawTrace.locator('summary').click();
      assert.equal(await rawTrace.evaluate(node => node.open), true);
      await rawTrace.filter({ hasText: '"kind": "log"' }).waitFor();
      assert.equal(
        await page.locator('#surfaceList').evaluate(node => node.scrollWidth <= node.clientWidth + 1),
        true,
      );
      await rawTrace.locator('summary').click();
    }
    await shot(page, `${runtime.screenshotIndex}-${runtime.runtime}-background-output.png`);
    await page.locator('#closeSurfaceBtn').click();

    currentPhase = `${runtime.runtime}:native-history-resume`;
    await openModelsSettings(page);
    const [historyResponse] = await Promise.all([
      page.waitForResponse(response => {
        const responseUrl = new URL(response.url());
        return responseUrl.pathname === '/api/external-cli/sessions'
          && responseUrl.searchParams.get('runtime') === runtime.runtime;
      }),
      page.locator('#externalCliHistoryRuntime').selectOption(runtime.runtime),
    ]);
    assert.equal(historyResponse.status(), 200);
    const historyPayload = await historyResponse.json();
    const matchingHistoryCards = page.locator('#externalCliHistoryList .settings-card')
      .filter({ hasText: runtime.historyTitle });
    let historyCard = matchingHistoryCards.first();
    if (runtime.runtime === 'crush') {
      const nativeHistoryCard = matchingHistoryCards.filter({ hasText: 'Native login' });
      const managedHistoryCard = matchingHistoryCards.filter({ hasText: /Managed profile · [a-f0-9]{8}/u });
      await nativeHistoryCard.waitFor();
      await managedHistoryCard.waitFor();
      const sourceLabels = historyPayload.sessions
        .filter(session => session.title === runtime.historyTitle)
        .map(session => session.sourceLabel)
        .sort();
      assert.deepEqual(sourceLabels, [
        `Managed profile · ${runtime.managedProfileId.slice(0, 8)}`,
        'Native login',
      ]);
      assert.equal(await matchingHistoryCards.count(), 2);
      assert.equal(await nativeHistoryCard.count(), 1);
      assert.equal(await managedHistoryCard.count(), 1);
      historyCard = nativeHistoryCard;
    }
    await historyCard.waitFor();
    await historyCard.getByRole('button', { name: 'Inspect' }).click();
    await page.locator('#surfaceDrawer').waitFor({ state: 'visible' });
    await page.locator('#surfaceList').filter({ hasText: runtime.historyAnswer }).waitFor();
    await shot(page, `${runtime.screenshotIndex}-${runtime.runtime}-native-history-detail.png`);
    await page.getByRole('button', { name: 'Resume in this chat' }).click();
    await page.locator('#surfaceDrawer').waitFor({ state: 'hidden' });
    await send(page, runtime.historyFollowUp);
    await page.locator('#transcript')
      .filter({ hasText: `${runtime.prefix}:resume:${runtime.historyFollowUp}` })
      .waitFor();
    const latestInvocation = (await readInvocations())
      .filter(item => item.runtime === runtime.runtime)
      .at(-1);
    assert.equal(latestInvocation.sessionId, runtime.historyId, runtime.runtime);
    assert.equal(latestInvocation.resumed, true, runtime.runtime);
    verifiedRuntimes.push(runtime.runtime);
  }

  currentPhase = 'sanitized-runs-and-mobile-layout';
  const runsResponse = await api(page, '/api/external-cli/runs');
  assert.equal(runsResponse.status, 200);
  assert(runsResponse.body.runs.length >= RUNTIMES.length * 5);
  assert(runsResponse.body.runs.every(run => !('configId' in run)));
  assert(runsResponse.body.runs.every(run => !('hadamardSessionId' in run)));

  await page.setViewportSize({ width: 430, height: 900 });
  await openModelsSettings(page);
  assert.equal(await page.locator('#externalCliHistoryRuntime').inputValue(), 'crush');
  await Promise.all([
    page.waitForResponse(response => {
      const responseUrl = new URL(response.url());
      return responseUrl.pathname === '/api/external-cli/sessions'
        && responseUrl.searchParams.get('runtime') === 'crush';
    }),
    page.locator('#externalCliHistoryRefresh').click(),
  ]);
  await page.locator('#externalCliHistoryList .settings-card')
    .filter({ hasText: RUNTIME_BY_ID.crush.historyTitle })
    .first()
    .waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  const mobileLayout = await page.evaluate(() => {
    const sidebar = document.querySelector('.settings-sidebar')?.getBoundingClientRect();
    const main = document.querySelector('.settings-main')?.getBoundingClientRect();
    return sidebar && main ? { sidebarBottom: sidebar.bottom, mainTop: main.top } : null;
  });
  assert(mobileLayout && mobileLayout.mainTop >= mobileLayout.sidebarBottom - 1);
  await shot(page, '99-mobile-six-runtime-history.png');

  assert.equal(screenshots.length, 20, 'expected exactly 20 visual verification screenshots');
  assert.equal(visualChecks.length, screenshots.length, 'every screenshot must pass black-tile inspection');
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join('; ')}`);
  verifiedBrowserErrors = [...browserErrors];
} catch (error) {
  failure = error;
  if (app) {
    const windows = app.windows();
    if (windows[0]) await shot(windows[0], '99-failure.png').catch(() => undefined);
  }
} finally {
  await closeApplication().catch(() => app?.process().kill());
  await rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const report = {
  passed: !failure,
  currentPhase,
  verifiedRuntimes,
  visualChecks,
  error: failure ? failure.stack || failure.message || String(failure) : null,
  browserErrors: verifiedBrowserErrors ?? browserErrors,
  screenshots,
};
await writeFile(path.join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failure ? 1 : 0);
