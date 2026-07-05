#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const main = fileURLToPath(new URL('../dist/src/gui/electronMain.js', import.meta.url));
const prepareLauncher = fileURLToPath(new URL('../scripts/prepare-gui-launcher.mjs', import.meta.url));

function resolveElectronExecutable() {
  const electronExe = require('electron');
  if (process.platform === 'win32') {
    const brandedLauncher = join(dirname(electronExe), 'Actoviq.exe');
    if (!existsSync(brandedLauncher)) {
      const prep = spawnSync(process.execPath, [prepareLauncher], { stdio: 'inherit' });
      if (prep.status !== 0) {
        process.stderr.write(
          'Actoviq: branded launcher unavailable; taskbar may show the Electron icon.\n',
        );
      }
    }
    if (existsSync(brandedLauncher)) return brandedLauncher;
  }
  return electronExe;
}

const electron = resolveElectronExecutable();

const child = spawn(electron, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ACTOVIQ_GUI_ROOT: rootDir,
  },
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
