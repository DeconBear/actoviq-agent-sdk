import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutableInvocation } from '../src/parity/bridgeExecResolver.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('resolveExecutableInvocation', () => {
  it('passes ordinary executables and argv through unchanged', async () => {
    await expect(resolveExecutableInvocation(process.execPath, ['-e', 'console.log("ok")']))
      .resolves.toEqual({
        file: process.execPath,
        args: ['-e', 'console.log("ok")'],
      });
  });

  it.runIf(process.platform === 'win32')(
    'unwraps npm cmd shims without sending user input through cmd.exe',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-shim-'));
      tempRoots.push(root);
      const packageBin = path.join(root, 'node_modules', 'fake-cli', 'cli.js');
      await mkdir(path.dirname(packageBin), { recursive: true });
      await writeFile(packageBin, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8');
      const shim = path.join(root, 'fake.cmd');
      await writeFile(
        shim,
        '@ECHO off\r\n"%dp0%\\node_modules\\fake-cli\\cli.js" %*\r\n',
        'utf8',
      );
      const prompt = 'literal %GITHUB_TOKEN% & whoami "quoted"';

      await expect(resolveExecutableInvocation(shim, ['--json', prompt])).resolves.toEqual({
        file: process.execPath,
        args: [packageBin, '--json', prompt],
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an unparseable batch wrapper instead of shelling user input',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-shim-'));
      tempRoots.push(root);
      const shim = path.join(root, 'unsafe.cmd');
      await writeFile(shim, '@ECHO off\r\necho %*\r\n', 'utf8');

      await expect(resolveExecutableInvocation(shim, ['%TOKEN% & calc']))
        .rejects.toThrow(/Unsupported Windows CLI wrapper/);
    },
  );
});
