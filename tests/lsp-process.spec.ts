import { describe, expect, it } from 'vitest';

import { LspProcess } from '../src/codeIntel/lspProcess.js';

const fakeServerSource = `
let buffer = Buffer.alloc(0);
const send = value => {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
};
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n');
    if (split < 0) return;
    const match = buffer.subarray(0, split).toString().match(/Content-Length:\\s*(\\d+)/i);
    if (!match) { buffer = buffer.subarray(split + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < split + 4 + length) return;
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length));
    buffer = buffer.subarray(split + 4 + length);
    if (message.method === 'exit') process.exit(0);
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: { method: message.method } });
  }
});
`;

describe('LspProcess', () => {
  it('frames requests and resolves correlated JSON-RPC responses', async () => {
    const processClient = new LspProcess({
      command: process.execPath,
      args: ['-e', fakeServerSource],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    await expect(processClient.request('initialize', {})).resolves.toEqual({ method: 'initialize' });
    await processClient.dispose();
  });
});
