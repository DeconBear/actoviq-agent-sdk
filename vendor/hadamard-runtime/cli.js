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
    console.error('The bridge SDK requires a third-party agent runtime bundle.');
    console.error('For example, if you have Claude Code installed, link its bundle:');
    console.error(`  npx hadamard-link-runtime /path/to/claude-code`);
    console.error('');
    console.error('Or set the HADAMARD_RUNTIME_BUNDLE environment variable:');
    console.error(`  $env:HADAMARD_RUNTIME_BUNDLE="/path/to/runtime-bundle"  # PowerShell`);
    console.error(`  export HADAMARD_RUNTIME_BUNDLE="/path/to/runtime-bundle"  # Bash`);
    process.exit(1);
  }

  // Support HADAMARD_RUNTIME_BUNDLE, with legacy ACTOVIQ_RUNTIME_BUNDLE fallback.
  const bundlePath =
    process.env.HADAMARD_RUNTIME_BUNDLE ||
    process.env.ACTOVIQ_RUNTIME_BUNDLE ||
    compressedBundlePath;

  const cacheDir = path.join(os.tmpdir(), 'hadamard-runtime-cache');
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

await import(pathToFileURL(ensureRuntimeEntry()).href);
