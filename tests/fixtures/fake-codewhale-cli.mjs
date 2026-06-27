#!/usr/bin/env node
// Fake `codewhale` CLI — emits Claude Code-compatible stream-json.
// Used by bridge provider tests.
import process from 'node:process';

// The prompt is always the last positional argument after exec + its flags.
const execIdx = process.argv.indexOf('exec');
const tail = execIdx !== -1 ? process.argv.slice(execIdx + 1) : process.argv.slice(2);
const prompt = tail[tail.length - 1] ?? '';
const sessionId = 'codewhale-fixture-session';
const text = prompt === 'who-am-i' ? `codewhale:agent:inherit` : `codewhale:${prompt}`;
const emit = v => process.stdout.write(`${JSON.stringify(v)}\n`);

emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: ['Read','Edit'], mcp_servers: [], model: 'codewhale-default' });
emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text, stop_reason: 'end_turn', duration_ms: 5, num_turns: 1 });
