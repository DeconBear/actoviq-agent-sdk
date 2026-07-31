import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodeIntelligenceService } from '../src/codeIntel/codeIntelligenceService.js';
import { LanguageServerRegistry } from '../src/codeIntel/languageServerRegistry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const fakeServerSource = `
let buffer = Buffer.alloc(0);
const send = value => { const body = Buffer.from(JSON.stringify(value)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body); };
const loc = uri => ({ uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } });
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n'); if (split < 0) return;
    const match = buffer.subarray(0, split).toString().match(/Content-Length:\\s*(\\d+)/i); if (!match) return;
    const length = Number(match[1]); if (buffer.length < split + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(split + 4, split + 4 + length)); buffer = buffer.subarray(split + 4 + length);
    if (msg.method === 'exit') process.exit(0);
    if (msg.method === 'textDocument/didOpen') send({ jsonrpc:'2.0', method:'textDocument/publishDiagnostics', params:{ uri:msg.params.textDocument.uri, diagnostics:[{ message:'fake diagnostic', severity:2, range:loc(msg.params.textDocument.uri).range }] } });
    if (msg.id === undefined) continue;
    let result = {};
    if (msg.method === 'workspace/symbol') result = [{ name:'targetSymbol', kind:12, location:loc('file:///target.ts') }];
    if (msg.method === 'textDocument/definition' || msg.method === 'textDocument/references') result = [loc(msg.params.textDocument.uri)];
    send({ jsonrpc:'2.0', id:msg.id, result });
  }
});
`;

describe('CodeIntelligenceService', () => {
  it('provides symbol, definition, reference, and diagnostic queries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    await mkdir(root, { recursive: true });
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = new CodeIntelligenceService({
      workDir: root,
      registry: new LanguageServerRegistry([{
        id: 'fake',
        languages: ['typescript'],
        extensions: ['.ts'],
        command: process.execPath,
        args: ['-e', fakeServerSource],
      }]),
      timeoutMs: 2_000,
    });
    try {
      await expect(service.workspaceSymbols('target')).resolves.toEqual([
        expect.objectContaining({ name: 'targetSymbol' }),
      ]);
      await expect(service.definition(file, 0, 0)).resolves.toEqual([
        expect.objectContaining({ line: 1, character: 2 }),
      ]);
      await expect(service.references(file, 0, 0)).resolves.toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(service.diagnostics(file)).resolves.toEqual([
        expect.objectContaining({ message: 'fake diagnostic', severity: 2 }),
      ]);
    } finally {
      await service.close();
    }
  });

  it('rejects workspace path escapes before opening documents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-escape-'));
    tempDirs.push(root);
    const service = new CodeIntelligenceService({
      workDir: root,
      registry: new LanguageServerRegistry([{
        id: 'fake',
        languages: ['typescript'],
        extensions: ['.ts'],
        command: process.execPath,
        args: ['-e', fakeServerSource],
      }]),
      timeoutMs: 2_000,
    });
    try {
      await expect(service.definition('../secret.ts', 0, 0))
        .rejects.toThrow(/escapes workspace|outside workspace/);
    } finally {
      await service.close();
    }
  });
});
