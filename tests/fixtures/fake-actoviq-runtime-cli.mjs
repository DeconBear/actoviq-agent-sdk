#!/usr/bin/env node
import { writeSync } from 'node:fs';
import process from 'node:process';

function getFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index !== -1) {
    return process.argv[index + 1];
  }
  const assigned = process.argv.find(argument => argument.startsWith(`${flag}=`));
  return assigned?.slice(flag.length + 1);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

/** Write large payloads to a pipe in chunks, retrying EAGAIN until the parent drains. */
function writeFullySync(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(
        fd,
        buffer,
        offset,
        Math.min(64 * 1024, buffer.length - offset),
      );
    } catch (error) {
      if (error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) {
        const end = Date.now() + 1;
        while (Date.now() < end) {
          // Parent is still draining the pipe; brief yield then retry.
        }
        continue;
      }
      throw error;
    }
  }
}

const command = process.argv[2];
const positionalBoundary = process.argv.lastIndexOf('--');
const legacyPrompt = getFlagValue('-p');
const prompt = positionalBoundary >= 0
  ? process.argv[positionalBoundary + 1] ?? ''
  : legacyPrompt?.startsWith('-') ? '' : legacyPrompt ?? '';
const sessionId =
  getFlagValue('--session-id') ??
  getFlagValue('--resume') ??
  (hasFlag('--continue') ? 'fixture-continued-session' : 'fixture-session');
const mode = hasFlag('--fork-session')
  ? 'fork'
  : hasFlag('--continue')
    ? 'continue'
    : getFlagValue('--resume')
      ? 'resume'
      : getFlagValue('--session-id')
        ? 'session-id'
        : 'standalone';
const agent = getFlagValue('--agent') ?? 'inherit';
const includePartial = hasFlag('--include-partial-messages');
const envToken = process.env.ACTOVIQ_AUTH_TOKEN ?? 'missing';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command === 'agents') {
  const largeStdoutBytes = Number(process.env.ACTOVIQ_TEST_LARGE_STDOUT_BYTES ?? 0);
  if (Number.isFinite(largeStdoutBytes) && largeStdoutBytes > 0) {
    // Chunked writes avoid truncated/EAGAIN pipe failures when the fixture
    // emits multi-megabyte stdout (seen on Linux CI runners).
    writeFullySync(1, Buffer.alloc(largeStdoutBytes, 0x78));
    writeFullySync(1, '\n');
  }
  writeFullySync(
    1,
    [
      '3 active agents',
      '',
      'Built-in agents:',
      '  general-purpose · inherit',
      '  statusline-setup · medium',
      '',
      'Project agents:',
      '  reviewer · max · project memory',
      '  (shadowed by User) planner · min',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: process.cwd(),
  tools: ['Read', 'Edit', 'Task'],
  mcp_servers: [{ name: 'filesystem', status: 'connected' }],
  model: 'fixture-model',
  permissionMode: 'bypassPermissions',
  slash_commands: ['context', 'cost', 'review', 'compact', 'debug', 'verify'],
  agents: ['general-purpose', 'reviewer'],
  skills: ['debug', 'verify'],
  plugins: [{ name: 'fixture-plugin', source: 'builtin', path: '/plugins/fixture' }],
  env_token: envToken,
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL ?? undefined,
  anthropic_auth_token:
    process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? undefined,
  anthropic_auth_configured: Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  ),
});

if (prompt === 'retention-bounds') {
  for (let index = 0; index < 1_100; index += 1) {
    emit({
      type: 'stream_event',
      session_id: sessionId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: String(index) },
      },
    });
  }
  for (let index = 0; index < 200; index += 1) {
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `retained-assistant-${index}` }],
      },
    });
  }
}

if (prompt === 'large-stderr') {
  writeFullySync(2, Buffer.alloc(1024 * 1024 + 64 * 1024, 0x73));
  writeFullySync(2, 'stderr-tail');
}

const text =
  prompt === 'who-am-i'
    ? `mode:${mode};agent:${agent}`
    : prompt === 'check-argv'
      ? `argv:${process.argv.slice(2).join('|')}`
    : prompt === '/cost'
      ? 'Total cost:            $0.0000\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write'
      : prompt === '/context'
        ? [
            '## Context Usage',
            '',
            '**Model:** fixture-model  ',
            '**Tokens:** 1.2k / 200k (0.6%)',
            '',
            '### Estimated usage by category',
            '',
            '| Category | Tokens | Percentage |',
            '|----------|--------|------------|',
            '| System prompt | 700 | 0.4% |',
            '| Skills | 300 | 0.2% |',
            '| Messages | 200 | 0.1% |',
            '',
            '### Skills',
            '',
            '| Skill | Source | Tokens |',
            '|-------|--------|--------|',
            '| debug | bundled | 180 |',
            '| verify | project | 120 |',
            '',
            '### Custom Agents',
            '',
            '| Agent Type | Source | Tokens |',
            '|------------|--------|--------|',
            '| reviewer | project | 240 |',
            '',
            '### MCP Tools',
            '',
            '| Tool | Server | Tokens |',
            '|------|--------|--------|',
            '| read_file | filesystem | 80 |',
          ].join('\n')
        : prompt.startsWith('/compact')
          ? `compact:${prompt}`
          : `echo:${prompt};agent:${agent}`;

if (includePartial) {
  emit({
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: text.slice(0, Math.max(1, Math.floor(text.length / 2))),
      },
    },
  });
  emit({
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: text.slice(Math.max(1, Math.floor(text.length / 2))),
      },
    },
  });
}

emit({
  type: 'assistant',
  session_id: sessionId,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text,
      },
    ],
  },
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
