#!/usr/bin/env node
// Fake Reasonix ACP JSON-RPC process.
import process from 'node:process';
import readline from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const flagValue = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const transcriptPath = flagValue('--transcript');
if (transcriptPath) mkdirSync(path.dirname(transcriptPath), { recursive: true });
const logPath = process.env.HADAMARD_E2E_INVOCATIONS;
const log = value => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, 'utf8');
};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = 'reasonix-fixture-session';
let turn = 0;

log({ event: 'start', pid: process.pid });

for await (const line of input) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (record.method === 'initialize') {
    emit({
      jsonrpc: '2.0',
      id: record.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
      },
    });
    continue;
  }
  if (record.method === 'session/new') {
    log({ event: 'session/new', pid: process.pid });
    emit({
      jsonrpc: '2.0',
      id: record.id,
      result: {
        sessionId,
        configOptions: [
          { id: 'model', currentValue: 'fixture/default' },
          { id: 'effort', currentValue: 'medium' },
          { id: 'budget_usd', currentValue: '0' },
        ],
      },
    });
    continue;
  }
  if (record.method === 'session/load') {
    log({ event: 'session/load', pid: process.pid, sessionId: record.params?.sessionId });
    sessionId = record.params?.sessionId ?? sessionId;
    emit({
      jsonrpc: '2.0',
      id: record.id,
      result: { sessionId, configOptions: [] },
    });
    continue;
  }
  if (record.method === 'session/set_config_option') {
    log({ event: 'config', pid: process.pid, ...record.params });
    emit({ jsonrpc: '2.0', id: record.id, result: {} });
    continue;
  }
  if (record.method === 'session/cancel') {
    log({ event: 'cancel', pid: process.pid, sessionId: record.params?.sessionId });
    continue;
  }
  if (record.method !== 'session/prompt') continue;
  turn += 1;
  const block = Array.isArray(record.params?.prompt) ? record.params.prompt[0] : undefined;
  const prompt = typeof block?.text === 'string' ? block.text : '';
  log({ event: 'prompt', pid: process.pid, sessionId, prompt, turn });
  if (prompt === 'hang') continue;
  const text = prompt === 'who-am-i'
    ? 'reasonix:agent:inherit'
    : prompt === 'leak-secret'
      ? `reasonix:${process.env.DEEPSEEK_API_KEY ?? 'missing'}`
    : prompt === 'check-isolation'
      ? `reasonix:isolation:selected=${Boolean(process.env.DEEPSEEK_API_KEY)}:github=${Boolean(process.env.GITHUB_TOKEN)}:aws=${Boolean(process.env.AWS_SECRET_ACCESS_KEY)}:db=${Boolean(process.env.DATABASE_PASSWORD)}`
    : prompt === 'runtime-identity'
      ? `reasonix:pid=${process.pid}:session=${sessionId}:turn=${turn}`
    : `reasonix:${prompt}`;
  if (transcriptPath) {
    const timestamp = new Date().toISOString();
    appendFileSync(transcriptPath, `${JSON.stringify({ role: 'user', content: prompt, timestamp })}\n`, 'utf8');
    appendFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: text, timestamp })}\n`, 'utf8');
  }
  emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  });
  emit({
    jsonrpc: '2.0',
    id: record.id,
    result: { stopReason: 'end_turn' },
  });
}
