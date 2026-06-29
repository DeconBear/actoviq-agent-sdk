// Vendors @xterm/xterm (UMD) + CSS + @xterm/addon-fit (UMD) into assets/xterm/
// so the workbench terminal pane can load them via <link>/<script src> (same-
// origin, allowed by the GUI's script-src 'self' CSP). No bundler. assets/xterm/
// is gitignored — regenerate via `npm run prepare:xterm` for dev, and the
// dist:win script runs it before building the installer (plan phase 3).
//
// Phase 5 will extend this to also vendor @xterm/addon-search for Ctrl+R fuzzy
// history; addon-fit is all phase 3 needs (resize).
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'xterm');

function resolvePkg(name) {
  try { return require.resolve(name); } catch { return null; }
}
function pkgDir(name) {
  const entry = resolvePkg(name);
  if (!entry) return null;
  // Walk up to the package root (the dir containing package.json).
  let dir = dirname(entry);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

const targets = [
  // [pkg, path-within-pkg, out-name]
  ['@xterm/xterm', 'lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm', 'css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit', 'lib/addon-fit.js', 'addon-fit.js'],
];

let copied = 0;
const missing = [];
await mkdir(outDir, { recursive: true });
for (const [pkg, rel, outName] of targets) {
  const dir = pkgDir(pkg);
  if (!dir) { missing.push(pkg); continue; }
  const src = join(dir, rel);
  if (!existsSync(src)) { missing.push(`${pkg}/${rel}`); continue; }
  await copyFile(src, join(outDir, outName));
  copied += 1;
  process.stdout.write(`xterm: ${pkg}/${rel} -> assets/xterm/${outName}\n`);
}

if (missing.length) {
  process.stderr.write(`xterm: missing packages (${missing.join(', ')}). Run \`npm install\` — @xterm/xterm and @xterm/addon-fit are optionalDependencies.\n`);
  // Not fatal: the GUI still works without the terminal pane; the /assets/xterm/*
  // routes simply 404 and the renderer falls back. Exit 0 so `dist:win` does not
  // abort an arm64 build where the prebuilt happened to be absent.
  process.exit(0);
}
process.stdout.write(`xterm: ${copied} asset(s) vendored into assets/xterm/\n`);
