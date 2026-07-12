import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'actoviq-packed-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this verifier through npm.');

try {
  const packDirectory = path.join(temporaryRoot, 'pack');
  const consumerDirectory = path.join(temporaryRoot, 'consumer');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });

  const packed = await run(process.execPath, [npmCli,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDirectory,
  ], root);
  const packReport = JSON.parse(packed.stdout);
  const filename = packReport[0]?.filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not report a tarball filename.');
  }
  const tarball = path.join(packDirectory, filename);

  await writeFile(path.join(consumerDirectory, 'package.json'), JSON.stringify({
    name: 'actoviq-package-verifier',
    private: true,
    type: 'module',
  }, null, 2), 'utf8');
  await run(process.execPath, [npmCli,
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    tarball,
  ], consumerDirectory);

  const specifiers = Object.keys(packageJson.exports ?? {}).map(subpath => (
    subpath === '.' ? packageJson.name : `${packageJson.name}${subpath.slice(1)}`
  ));
  await writeFile(path.join(consumerDirectory, 'verify.mjs'), [
    `const specifiers = ${JSON.stringify(specifiers)};`,
    'for (const specifier of specifiers) {',
    '  const loaded = await import(specifier);',
    '  if (Reflect.ownKeys(loaded).length === 0) {',
    '    throw new Error(`Package export ${specifier} has no runtime exports.`);',
    '  }',
    '}',
    'console.log(`Imported ${specifiers.length} subpaths from the installed tarball.`);',
    '',
  ].join('\n'), 'utf8');

  const verified = await run(process.execPath, ['verify.mjs'], consumerDirectory);
  process.stdout.write(verified.stdout);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (typeof error?.stdout === 'string') process.stdout.write(error.stdout);
    if (typeof error?.stderr === 'string') process.stderr.write(error.stderr);
    throw error;
  }
}
