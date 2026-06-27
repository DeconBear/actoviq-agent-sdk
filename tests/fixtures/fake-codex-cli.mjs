#!/usr/bin/env node
// Fake `codex` CLI for directCli-mode tests. Emits the codex exec --json
// wire format (thread.started → turn.started → item.started/completed with
// agent_message → turn.completed) so the CodexNormalizer in bridgeProviders.ts
// can translate it into the system/assistant/result trio.
//
// Invocation shape mirrors real `codex exec --json ... <prompt>`:
//   node fake-codex-cli.mjs exec --json --skip-git-repo-check --color never --ephemeral --dangerously-bypass-approvals-and-sandbox [-m X] <prompt>
import process from 'node:process';

const argv = process.argv.slice(2);
// codex puts the prompt last positionally (after the subcommand + flags).
const prompt = argv.filter(arg => !arg.startsWith('-') && arg !== 'exec').pop() ?? '';
const modelIndex = argv.indexOf('-m');
const modelFlag = modelIndex !== -1 ? argv[modelIndex + 1] : undefined;

// Env echo for provider-isolation assertions.
const openaiKey = process.env.OPENAI_API_KEY ?? undefined;
const anthropicBase = process.env.ANTHROPIC_BASE_URL ?? undefined;

const threadId = 'codex-fixture-thread';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });

// Failure path: emit turn.failed (with a preceding top-level error) when the
// prompt asks for it, exercising the CodexNormalizer's error-result mapping.
if (prompt === 'force-fail') {
  emit({ type: 'error', message: 'codex usage limit reached' });
  emit({ type: 'turn.failed', error: { message: 'codex usage limit reached' } });
  process.exit(0);
}

// Assistant message as an agent_message item: started (empty) then completed.
const text = prompt === 'who-am-i'
  ? `codex:agent:${modelFlag ?? 'inherit'}`
  : prompt === 'check-env'
    ? `codex:env:${openaiKey ?? 'none'}:${anthropicBase ?? 'none'}`
    : `codex:${prompt}`;

emit({ type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: '' } });
emit({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text } });

emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: text.length, reasoning_output_tokens: 0 },
});
