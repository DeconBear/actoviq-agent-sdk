#!/usr/bin/env node
import process from 'node:process';

function getFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const command = process.argv[2];
const prompt = getFlagValue('-p') ?? '';
const sessionId = getFlagValue('--session-id') ?? getFlagValue('--resume') ?? 'fixture-session';
const mode = getFlagValue('--resume') ? 'resume' : getFlagValue('--session-id') ? 'session-id' : 'standalone';
const agent = getFlagValue('--agent') ?? 'inherit';
const includePartial = hasFlag('--include-partial-messages');
const envToken = process.env.ACTOVIQ_AUTH_TOKEN ?? 'missing';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command === 'agents') {
  process.stdout.write(
    [
      '3 active agents',
      '',
      'Built-in agents:',
      '  general-purpose · inherit',
      '  statusline-setup · sonnet',
      '',
      'Project agents:',
      '  reviewer · opus · project memory',
      '  (shadowed by User) planner · haiku',
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
});

const text =
  prompt === 'who-am-i'
    ? `mode:${mode};agent:${agent}`
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
