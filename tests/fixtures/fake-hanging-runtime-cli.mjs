#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const pidFile = process.env.ACTOVIQ_TEST_CHILD_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

const terminationLogFile = process.env.ACTOVIQ_TEST_TERMINATION_LOG_FILE;
if (terminationLogFile) {
  process.on('SIGTERM', () => appendFileSync(terminationLogFile, 'parent\n', 'utf8'));
}

const grandchildPidFile = process.env.ACTOVIQ_TEST_GRANDCHILD_PID_FILE;
if (grandchildPidFile) {
  const grandchildSource = [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid), 'utf8');`,
    terminationLogFile
      ? `process.on('SIGTERM', () => appendFileSync(${JSON.stringify(terminationLogFile)}, 'grandchild\\n', 'utf8'));`
      : '',
    'setInterval(() => {}, 1_000);',
  ].join('\n');
  const grandchild = spawn(
    process.execPath,
    ['--input-type=module', '-e', grandchildSource],
    { stdio: 'ignore' },
  );
  grandchild.unref();
}

process.stdout.write(`${JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'hanging-runtime-session',
  tools: [],
  mcp_servers: [],
  slash_commands: [],
  agents: [],
  skills: [],
  plugins: [],
})}\n`);

if (process.env.ACTOVIQ_TEST_MALFORMED_OUTPUT === '1') {
  process.stdout.write('{malformed-json\n');
}

setInterval(() => {}, 1_000);
