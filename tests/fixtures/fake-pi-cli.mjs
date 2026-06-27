#!/usr/bin/env node
// Fake `pi` CLI for directCli-mode tests. Emits the pi JSONL wire format
// (session header → agent_start → message_update text deltas → message_end →
// agent_end) so the PiNormalizer in bridgeProviders.ts can translate it into
// the system/assistant/result trio the bridge expects.
//
// Invocation shape mirrors real `pi -p --mode json ... <prompt>`:
//   node fake-pi-cli.mjs -p --mode json --no-session --no-approve [--model X] <prompt>
import process from 'node:process';

// The prompt is the last positional argument (pi convention).
const prompt = process.argv
  .slice(2)
  .filter(arg => !arg.startsWith('-'))
  .pop() ?? '';
const modelFlag = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : undefined;

// Env echo so tests can assert provider-specific credential isolation.
const openaiKey = process.env.OPENAI_API_KEY ?? undefined;
const anthropicBase = process.env.ANTHROPIC_BASE_URL ?? undefined;

const sessionId = 'pi-fixture-session';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// pi session header (carries id + cwd; no model, no tool catalog).
emit({ type: 'session', version: 3, id: sessionId, timestamp: '2026-06-27T10:41:50.233Z', cwd: process.cwd() });
emit({ type: 'agent_start' });

// Assistant message: stream text via message_update deltas, finalize at message_end.
const text = prompt === 'who-am-i'
  ? `pi:agent:${modelFlag ?? 'inherit'}`
  : prompt === 'check-env'
    ? `pi:env:${openaiKey ?? 'none'}:${anthropicBase ?? 'none'}`
    : `pi:${prompt}`;
const mid = Math.max(1, Math.floor(text.length / 2));
emit({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(0, mid) },
});
emit({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(mid) },
});
emit({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'openai',
    model: modelFlag ?? 'pi-default-model',
    usage: { input: 10, output: text.length, totalTokens: 10 + text.length },
    stopReason: 'stop',
  },
});

emit({ type: 'agent_end', messages: [], willRetry: false });
