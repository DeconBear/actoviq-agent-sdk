#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = resolve(sdkRoot, 'node_modules', '.bin', 'tsx');
const entry = resolve(sdkRoot, 'bin', 'actoviq-sb.ts');

spawn(
  process.platform === 'win32' ? tsxBin + '.cmd' : tsxBin,
  [entry, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: process.platform === 'win32' },
).on('exit', (code) => { process.exit(code ?? 1); });
