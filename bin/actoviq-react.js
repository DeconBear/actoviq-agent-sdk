#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapperDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(wrapperDir, '..');
const tsxBin = resolve(sdkRoot, 'node_modules', '.bin', 'tsx');
const exampleFile = resolve(sdkRoot, 'examples', 'react-loop.ts');

const child = spawn(
  process.platform === 'win32' ? tsxBin + '.cmd' : tsxBin,
  [exampleFile, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
child.on('exit', (code) => { process.exit(code ?? 1); });
