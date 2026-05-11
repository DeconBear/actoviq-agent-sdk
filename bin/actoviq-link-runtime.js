#!/usr/bin/env node
/**
 * Link or copy a Claude Code runtime bundle for use with the bridge SDK.
 *
 * Usage:
 *   npx actoviq-link-runtime /path/to/claude-code
 *   npx actoviq-link-runtime /path/to/runtime.bundle.br
 */
import { existsSync, symlinkSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetDir = resolve(__dirname, '..', 'vendor', 'actoviq-runtime');
const targetPath = join(targetDir, 'runtime.bundle.br');

const input = process.argv[2];
if (!input || input === '--help' || input === '-h') {
  console.log('Usage: actoviq-link-runtime <path>');
  console.log('');
  console.log('  <path>  Path to a Claude Code installation directory,');
  console.log('          or directly to a runtime.bundle.br file.');
  console.log('');
  console.log('Examples:');
  console.log('  actoviq-link-runtime ~/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code');
  console.log('  actoviq-link-runtime /usr/local/lib/node_modules/@anthropic-ai/claude-code');
  console.log('  actoviq-link-runtime ./runtime.bundle.br');
  console.log('');
  console.log('The bridge SDK uses the Claude Code runtime bundle to provide');
  console.log('the reference implementation. You must have a licensed copy');
  console.log('of Claude Code to use this feature.');
  process.exit(0);
}

const sourcePath = resolve(input);

// If the input is a directory, look for the bundle inside it
let bundlePath;
if (existsSync(sourcePath) && existsSync(join(sourcePath, 'vendor', 'actoviq-runtime', 'runtime.bundle.br'))) {
  bundlePath = join(sourcePath, 'vendor', 'actoviq-runtime', 'runtime.bundle.br');
} else if (existsSync(sourcePath) && sourcePath.endsWith('.br')) {
  bundlePath = sourcePath;
} else if (existsSync(join(sourcePath, 'runtime.bundle.br'))) {
  bundlePath = join(sourcePath, 'runtime.bundle.br');
} else {
  console.error(`Could not find runtime.bundle.br in: ${sourcePath}`);
  console.error('Make sure the path points to a Claude Code installation or a runtime.bundle.br file.');
  process.exit(1);
}

if (!existsSync(bundlePath)) {
  console.error(`Bundle not found at: ${bundlePath}`);
  process.exit(1);
}

// Remove existing target if any
if (existsSync(targetPath)) {
  console.log(`Removing existing: ${targetPath}`);
  unlinkSync(targetPath);
}

// Try symlink first, fall back to copy
try {
  mkdirSync(targetDir, { recursive: true });
  symlinkSync(bundlePath, targetPath);
  console.log(`Linked: ${bundlePath} -> ${targetPath}`);
} catch {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(bundlePath, targetPath);
  console.log(`Copied: ${bundlePath} -> ${targetPath}`);
}

console.log('');
console.log('Bridge runtime bundle is now available.');
console.log('Run: npx actoviq-interactive-agent');
