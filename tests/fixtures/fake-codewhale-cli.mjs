#!/usr/bin/env node
// Fake CodeWhale 0.8 stream-json protocol.
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const boundary = process.argv.lastIndexOf('--');
const prompt = boundary >= 0 ? process.argv[boundary + 1] ?? '' : '';
const resumeArgument = process.argv.find(argument => argument.startsWith('--resume='));
const resumedSessionId = resumeArgument?.slice('--resume='.length);
const nativeSessionId = resumedSessionId || 'codewhale-fixture-session';
const sessionsRoot = process.env.CODEWHALE_HOME
  ? path.join(process.env.CODEWHALE_HOME, 'sessions')
  : undefined;
if (resumedSessionId && sessionsRoot) {
  await access(path.join(sessionsRoot, `${resumedSessionId}.json`)).catch(() => {
    process.stderr.write(`missing CodeWhale session: ${resumedSessionId}\n`);
    process.exit(2);
  });
}
const text = prompt === 'who-am-i'
  ? 'codewhale:agent:inherit'
  : prompt === 'check-resume'
    ? `codewhale:resume:${resumedSessionId ?? 'none'}`
    : prompt === 'check-isolation'
      ? `codewhale:isolation:selected=${Boolean(process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY)}:github=${Boolean(process.env.GITHUB_TOKEN)}:aws=${Boolean(process.env.AWS_SECRET_ACCESS_KEY)}:db=${Boolean(process.env.DATABASE_PASSWORD)}`
    : `codewhale:${prompt}`;
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const redactedIdentifierForLog = identifier => {
  const bytes = Buffer.from(identifier, 'utf8');
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  hash = BigInt.asUintN(64, (hash ^ BigInt(bytes.length)) * 0x100000001b3n);
  return `<redacted:${hash.toString(16).padStart(16, '0')}>`;
};

if (sessionsRoot) {
  const now = new Date().toISOString();
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(path.join(sessionsRoot, `${nativeSessionId}.json`), JSON.stringify({
    schema_version: 1,
    metadata: {
      id: nativeSessionId,
      title: 'Fixture CodeWhale session',
      created_at: now,
      updated_at: now,
      message_count: 2,
      total_tokens: 4 + text.length,
      model: 'codewhale-default',
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

emit({ type: 'content', content: text });
if (prompt === 'tool-check') {
  emit({ type: 'tool_use', id: 'cw-tool-1', name: 'read_file', input: { path: 'README.md' } });
  emit({ type: 'tool_result', id: 'cw-tool-1', output: '# readme', status: 'success' });
}
emit({
  type: 'metadata',
  meta: {
    model: 'codewhale-default',
    input_tokens: 4,
    output_tokens: text.length,
    session_id: redactedIdentifierForLog(nativeSessionId),
    workspace: process.cwd(),
    message_count: 2,
    status: 'completed',
  },
});
emit({ type: 'done' });
