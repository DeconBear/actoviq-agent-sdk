#!/usr/bin/env node
// Fake Pi managed RPC process. Prompts arrive as JSON over stdin so tests cover
// the same argv-injection boundary as the real `pi --mode rpc` transport.
import process from 'node:process';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const flagValue = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const modelFlag = flagValue('--model');
const providerFlag = flagValue('--provider') ?? 'openai';
const sessionId = flagValue('--session') ?? flagValue('--session-id') ?? 'pi-fixture-session';
const sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionPath = sessionsRoot ? path.join(sessionsRoot, `${sessionId}.jsonl`) : undefined;
if (flagValue('--session') && sessionPath && !existsSync(sessionPath)) {
  process.stderr.write(`missing Pi session: ${sessionId}\n`);
  process.exit(2);
}
const openaiKey = process.env.OPENAI_API_KEY ?? undefined;
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? undefined;
const anthropicBase = process.env.ANTHROPIC_BASE_URL ?? undefined;
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    emit({
      id: request.id,
      type: 'response',
      success: true,
      data: {
        sessionId,
        cwd: process.cwd(),
        model: modelFlag ?? 'pi-default-model',
      },
    });
    continue;
  }
  if (request.type === 'abort') {
    emit({ id: request.id, type: 'response', success: true });
    emit({ type: 'agent_end' });
    continue;
  }
  if (request.type !== 'prompt') continue;

  emit({ id: request.id, type: 'response', success: true });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  const prompt = typeof request.message === 'string' ? request.message : '';
  const selectedKey = providerFlag === 'anthropic' ? anthropicKey : openaiKey;
  const text = prompt === 'who-am-i'
    ? `pi:agent:${modelFlag ?? 'inherit'}`
    : prompt === 'check-env'
      ? `pi:env:${selectedKey ?? 'none'}:${anthropicBase ?? 'none'}`
      : prompt === 'check-isolation'
        ? `pi:isolation:selected=${Boolean(selectedKey)}:github=${Boolean(process.env.GITHUB_TOKEN)}:aws=${Boolean(process.env.AWS_SECRET_ACCESS_KEY)}:db=${Boolean(process.env.DATABASE_PASSWORD)}`
      : `pi:${prompt}`;
  if (sessionPath) {
    const now = new Date().toISOString();
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: now, cwd: process.cwd() }),
      JSON.stringify({ type: 'message', id: 'user0001', parentId: null, timestamp: now, message: { role: 'user', content: prompt } }),
      JSON.stringify({ type: 'message', id: 'answer01', parentId: 'user0001', timestamp: now, message: { role: 'assistant', model: modelFlag ?? 'pi-default-model', content: [{ type: 'text', text }] } }),
    ].join('\n'), 'utf8');
  }
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
      provider: providerFlag,
      model: modelFlag ?? 'pi-default-model',
      usage: { input: 10, output: text.length, cost: { total: 0 } },
      stopReason: 'stop',
    },
  });
  emit({ type: 'turn_end' });
  emit({ type: 'agent_end', messages: [], willRetry: false });
}
