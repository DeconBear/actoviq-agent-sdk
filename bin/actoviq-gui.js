#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const main = fileURLToPath(new URL('../dist/src/gui/electronMain.js', import.meta.url));

const child = spawn(electron, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to start actoviq-gui:', error);
  process.exit(1);
});
