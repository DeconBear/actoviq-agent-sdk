import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const compressedBundlePath = path.join(moduleDir, 'runtime.bundle.br');
const bundleHash = '1a906d17618d1f42';

function ensureRuntimeEntry() {
  if (!existsSync(compressedBundlePath)) {
    console.error('Bridge runtime bundle not found.');
    console.error(`Expected at: ${compressedBundlePath}`);
    console.error('');
    console.error('The bridge SDK requires a Claude Code runtime bundle.');
    console.error('If you have Claude Code installed, link its bundle:');
    console.error(`  npx actoviq-link-runtime /path/to/claude-code`);
    console.error('');
    console.error('Or set the ACTOVIQ_RUNTIME_BUNDLE environment variable:');
    console.error(`  $env:ACTOVIQ_RUNTIME_BUNDLE="/path/to/runtime.bundle.br"  # PowerShell`);
    console.error(`  export ACTOVIQ_RUNTIME_BUNDLE="/path/to/runtime.bundle.br"  # Bash`);
    process.exit(1);
  }

  // Support ACTOVIQ_RUNTIME_BUNDLE override
  const bundlePath = process.env.ACTOVIQ_RUNTIME_BUNDLE || compressedBundlePath;

  const cacheDir = path.join(os.tmpdir(), 'actoviq-runtime-cache');
  const entryPath = path.join(cacheDir, `${bundleHash}.mjs`);

  if (!existsSync(entryPath)) {
    mkdirSync(cacheDir, { recursive: true });
    const compressed = readFileSync(bundlePath);
    const source = brotliDecompressSync(compressed);
    const digest = createHash('sha256').update(source).digest('hex');
    const nextPath = path.join(cacheDir, `${digest}.mjs`);

    if (!existsSync(nextPath)) {
      writeFileSync(nextPath, source);
    }

    if (nextPath !== entryPath) {
      writeFileSync(entryPath, readFileSync(nextPath));
    }
  }

  return entryPath;
}

const entryPath = ensureRuntimeEntry();
await import(pathToFileURL(entryPath).href);
