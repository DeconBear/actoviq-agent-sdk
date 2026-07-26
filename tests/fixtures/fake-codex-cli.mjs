#!/usr/bin/env node
// Fake `codex` CLI for directCli-mode tests. Emits the codex exec --json
// wire format (thread.started → turn.started → item.started/completed with
// agent_message → turn.completed) so the CodexNormalizer in bridgeProviders.ts
// can translate it into the system/assistant/result trio.
//
// Invocation shapes mirror real Codex:
//   codex exec --json ... <prompt>
//   codex exec resume --json ... <thread-id> <prompt>
import process from 'node:process';

const argv = process.argv.slice(2);
// Codex accepts `--` before positional values. Prefer that boundary so tests
// can distinguish a prompt beginning with `-` from a CLI option.
const positionalBoundary = argv.lastIndexOf('--');
const prompt = positionalBoundary >= 0
  ? argv.slice(positionalBoundary + 1).at(-1) ?? ''
  : argv.filter(arg => !arg.startsWith('-') && arg !== 'exec').pop() ?? '';
const modelIndex = argv.indexOf('-m');
const modelFlag = modelIndex !== -1 ? argv[modelIndex + 1] : undefined;
const resumeMode = argv[1] === 'resume';

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

if (prompt === 'exercise-tools') {
  emit({
    type: 'item.started',
    item: { id: 'cmd-1', type: 'command_execution', command: 'printf codex-tool', status: 'in_progress' },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'printf codex-tool',
      aggregated_output: 'codex-tool',
      exit_code: 0,
      status: 'completed',
    },
  });
  emit({
    type: 'item.started',
    item: {
      id: 'file-1',
      type: 'file_change',
      changes: [{ path: 'README.md', kind: 'update' }],
      status: 'in_progress',
    },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'file-1',
      type: 'file_change',
      changes: [{ path: 'README.md', kind: 'update' }],
      status: 'completed',
    },
  });
  emit({
    type: 'item.started',
    item: {
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      status: 'in_progress',
    },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      result: { content: [{ type: 'text', text: 'read ok' }] },
      status: 'completed',
    },
  });
}

// Assistant message as an agent_message item: started (empty) then completed.
const text = prompt === 'who-am-i'
  ? `codex:agent:${modelFlag ?? 'inherit'}`
  : prompt === 'check-permissions'
    ? `codex:args:${argv.join('|')}`
  : prompt === 'check-resume'
    ? `codex:${resumeMode ? 'resume' : 'new'}:${argv.includes(threadId) ? threadId : 'missing-thread'}`
  : prompt === 'check-env'
    ? `codex:env:${openaiKey ?? 'none'}:${anthropicBase ?? 'none'}`
    : `codex:${prompt}`;

emit({ type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: '' } });
emit({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text } });

emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: text.length, reasoning_output_tokens: 0 },
});
