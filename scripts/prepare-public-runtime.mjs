import { brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);

const projectRoot = process.cwd();
const vendorRoot = path.join(projectRoot, 'vendor', 'actoviq-runtime');
const publicBundlePath = path.join(vendorRoot, 'runtime.bundle.br');
const cliWrapperPath = path.join(vendorRoot, 'cli.js');
const summaryPath = path.join(vendorRoot, 'SYNC_SUMMARY.json');
const bunExecutable = process.platform === 'win32'
  ? path.join(projectRoot, 'node_modules', 'bun', 'bin', 'bun.exe')
  : path.join(projectRoot, 'node_modules', 'bun', 'bin', 'bun');

function createCliWrapper(bundleHash) {
  return `import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const compressedBundlePath = path.join(moduleDir, 'runtime.bundle.br');
const bundleHash = '${bundleHash}';

function ensureRuntimeEntry() {
  const cacheDir = path.join(os.tmpdir(), 'actoviq-runtime-cache');
  const entryPath = path.join(cacheDir, \`\${bundleHash}.mjs\`);

  if (!existsSync(entryPath)) {
    mkdirSync(cacheDir, { recursive: true });
    const compressed = readFileSync(compressedBundlePath);
    const source = brotliDecompressSync(compressed);
    const digest = createHash('sha256').update(source).digest('hex');
    const nextPath = path.join(cacheDir, \`\${digest}.mjs\`);

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
`;
}

async function main() {
  await mkdir(vendorRoot, { recursive: true });

  const tempBundlePath = path.join(
    process.env.TEMP ?? process.env.TMP ?? projectRoot,
    'actoviq-runtime-public.min.mjs',
  );

  await execFileAsync(
    bunExecutable,
    [
      'build',
      cliWrapperPath,
      '--target=node',
      '--format=esm',
      '--minify',
      '--external',
      'ws',
      '--outfile',
      tempBundlePath,
    ],
    { cwd: projectRoot },
  );

  const minifiedBundle = await readFile(tempBundlePath);
  const bundleHash = createHash('sha256').update(minifiedBundle).digest('hex').slice(0, 16);
  const compressedBundle = brotliCompressSync(minifiedBundle);

  await writeFile(publicBundlePath, compressedBundle);
  await writeFile(cliWrapperPath, createCliWrapper(bundleHash), 'utf8');

  await rm(tempBundlePath, { force: true });
  await rm(path.join(vendorRoot, 'src'), { recursive: true, force: true });
  await rm(path.join(vendorRoot, 'shims'), { recursive: true, force: true });

  const summary = {
    upstreamRootName: 'actoviq-runtime-upstream',
    upstreamRootSource: 'sanitized-sync',
    generatedAt: new Date().toISOString(),
    runtimeBundleHash: bundleHash,
    runtimeBundleFile: 'runtime.bundle.br',
    layout: 'public-runtime-wrapper',
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
