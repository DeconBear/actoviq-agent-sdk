import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const projectRoot = process.cwd();
const legacyUpstreamDirName = ['cl', 'aude-code-main'].join('');
const legacyShimSpecifier = ['@', 'an', 'thropic-ai', '/', 'cl', 'aude-agent-sdk'].join('');
const legacyFeaturePrefix = ['CL', 'AUDE_CODE_FEATURE_'].join('');
const legacyFeatureListKey = ['CL', 'AUDE_CODE_FEATURES'].join('');
const upstreamRoot = path.resolve(projectRoot, '..', process.env.ACTOVIQ_UPSTREAM_ROOT ?? legacyUpstreamDirName);
const upstreamSrcRoot = path.join(upstreamRoot, 'src');
const vendorRoot = path.join(projectRoot, 'vendor', 'actoviq-runtime');
const vendorSrcRoot = path.join(vendorRoot, 'src');
const vendorShimRoot = path.join(vendorRoot, 'shims');

const TEXT_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mjs',
  '.cjs',
]);

function normalizePathForImport(filePath) {
  return filePath.split(path.sep).join('/');
}

function withDotSlash(specifier) {
  if (specifier.startsWith('../') || specifier.startsWith('./')) {
    return specifier;
  }
  return `./${specifier}`;
}

function createRelativeImport(fromFile, toFile) {
  const relativePath = path.relative(path.dirname(fromFile), toFile);
  return withDotSlash(normalizePathForImport(relativePath));
}

function rewriteSpecifiers(sourceText, sourceFile, destFile) {
  let output = sourceText;

  const replaceSrcSpecifier = (_match, prefix, quote, specifier, suffix = '') => {
    const upstreamTarget = path.join(upstreamSrcRoot, ...specifier.split('/'));
    const vendorTarget = path.join(vendorSrcRoot, ...specifier.split('/'));
    const relativeSpecifier = createRelativeImport(destFile, vendorTarget);
    return `${prefix}${quote}${relativeSpecifier}${suffix}${quote}`;
  };

  output = output.replace(
    /(from\s+)(['"])src\/([^'"]+?)(\.(?:js|ts|tsx|jsx|mjs|cjs))?\2/g,
    replaceSrcSpecifier,
  );
  output = output.replace(
    /(import\(\s*)(['"])src\/([^'"]+?)(\.(?:js|ts|tsx|jsx|mjs|cjs))?\2(\s*\))/g,
    (match, prefix, quote, specifier, suffix = '', closing) => {
      const vendorTarget = path.join(vendorSrcRoot, ...specifier.split('/'));
      const relativeSpecifier = createRelativeImport(destFile, vendorTarget);
      return `${prefix}${quote}${relativeSpecifier}${suffix}${quote}${closing}`;
    },
  );
  output = output.replace(
    /(require\(\s*)(['"])src\/([^'"]+?)(\.(?:js|ts|tsx|jsx|mjs|cjs))?\2(\s*\))/g,
    (match, prefix, quote, specifier, suffix = '', closing) => {
      const vendorTarget = path.join(vendorSrcRoot, ...specifier.split('/'));
      const relativeSpecifier = createRelativeImport(destFile, vendorTarget);
      return `${prefix}${quote}${relativeSpecifier}${suffix}${quote}${closing}`;
    },
  );

  const bunBundleShim = createRelativeImport(
    destFile,
    path.join(vendorShimRoot, 'bun-bundle.ts'),
  );
  output = output.replace(
    /(from\s+)(['"])bun:bundle\2/g,
    `$1$2${bunBundleShim}$2`,
  );

  const sdkShim = createRelativeImport(
    destFile,
    path.join(vendorShimRoot, 'actoviq-agent-sdk.ts'),
  );
  output = output.replace(
    new RegExp(`(from\\s+)(['\"])${legacyShimSpecifier.replace(/[.*+?^${}()|[\]\]/g, '\\$&')}\\2`, 'g'),
    `$1$2${sdkShim}$2`,
  );

  return output;
}

function applyFileSpecificPatches(relativePath, sourceText) {
  if (
    normalizePathForImport(relativePath) === 'utils/protectedNamespace.ts' &&
    sourceText.trim() === 'export const protectedNamespace = {};'
  ) {
    return `export function checkProtectedNamespace() {\n  return false\n}\n\nexport const protectedNamespace = {};\n`;
  }

  return sourceText;
}

async function* walkDirectory(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(fullPath);
      continue;
    }
    yield fullPath;
  }
}

async function syncTree() {
  const summary = {
    copiedFiles: 0,
    rewrittenFiles: 0,
    bunBundleRewrites: 0,
    srcAliasRewrites: 0,
    sdkSelfRewrites: 0,
    copiedRootFiles: 0,
    generatedJsStubs: 0,
  };

  await rm(vendorRoot, { force: true, recursive: true });
  await mkdir(vendorSrcRoot, { recursive: true });
  await mkdir(vendorShimRoot, { recursive: true });

  for await (const upstreamFile of walkDirectory(upstreamSrcRoot)) {
    const relativePath = path.relative(upstreamSrcRoot, upstreamFile);
    const destinationFile = path.join(vendorSrcRoot, relativePath);
    await mkdir(path.dirname(destinationFile), { recursive: true });

    const extension = path.extname(upstreamFile);
    if (!TEXT_FILE_EXTENSIONS.has(extension)) {
      await cp(upstreamFile, destinationFile);
      summary.copiedFiles += 1;
      continue;
    }

    const sourceText = await readFile(upstreamFile, 'utf8');
    const patchedText = applyFileSpecificPatches(relativePath, sourceText);
    const rewrittenText = rewriteSpecifiers(patchedText, upstreamFile, destinationFile);
    summary.copiedFiles += 1;

    if (rewrittenText !== sourceText) {
      summary.rewrittenFiles += 1;
      summary.bunBundleRewrites += (sourceText.match(/bun:bundle/g) ?? []).length;
      summary.srcAliasRewrites += (sourceText.match(/['"]src\//g) ?? []).length;
      summary.sdkSelfRewrites += (
        sourceText.match(new RegExp(legacyShimSpecifier.replace(/[.*+?^${}()|[\]\]/g, '\\$&'), 'g')) ?? []
      ).length;
    }

    await writeFile(destinationFile, rewrittenText, 'utf8');

    if (extension === '.ts' || extension === '.tsx') {
      const stubPath = destinationFile.replace(/\.(tsx|ts)$/u, '.js');
      const relativeSourcePath = `./${path.basename(destinationFile).replace(/\\/g, '/')}`;
      const stubText = `export * from '${relativeSourcePath}';\n`;
      await writeFile(stubPath, stubText, 'utf8');
      summary.generatedJsStubs += 1;
    }
  }

  const upstreamCliFile = path.join(upstreamRoot, 'cli.js');
  const vendorCliFile = path.join(vendorRoot, 'cli.js');
  await cp(upstreamCliFile, vendorCliFile);
  summary.copiedRootFiles += 1;

  await writeFile(
    path.join(vendorRoot, 'SYNC_SUMMARY.json'),
    `${JSON.stringify(
      {
        upstreamRootName: path.basename(upstreamRoot),
        upstreamRootSource: process.env.ACTOVIQ_UPSTREAM_ROOT
          ? 'ACTOVIQ_UPSTREAM_ROOT'
          : legacyUpstreamDirName,
        generatedAt: new Date().toISOString(),
        ...summary,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function writeShims() {
  await mkdir(vendorShimRoot, { recursive: true });

  const bunBundleShim = `const legacyFeaturePrefix = ['CL', 'AUDE_CODE_FEATURE_'].join('');
const legacyFeatureListKey = ['CL', 'AUDE_CODE_FEATURES'].join('');

export function feature(name) {
  const normalized = String(name ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const enabledFeatures = (process.env.ACTOVIQ_RUNTIME_FEATURES ?? process.env[legacyFeatureListKey] ?? '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);

  if (enabledFeatures.includes(normalized)) {
    return true;
  }

  const flag =
    process.env[\`ACTOVIQ_RUNTIME_FEATURE_\${normalized}\`] ??
    process.env[\`${legacyFeaturePrefix}\${normalized}\`];
  if (flag == null) {
    return false;
  }

  return /^(1|true|yes|on)$/i.test(flag);
}
`;

  const actoviqAgentSdkShim = `export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
];

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number];
export type PermissionMode = ExternalPermissionMode | 'auto' | 'bubble';

/**
 * Minimal compatibility surface for upstream modules that currently import
 * types from the published Actoviq Agent SDK package.
 */
export {};
`;

  await writeFile(path.join(vendorShimRoot, 'bun-bundle.ts'), bunBundleShim, 'utf8');
  await writeFile(
    path.join(vendorShimRoot, 'actoviq-agent-sdk.ts'),
    actoviqAgentSdkShim,
    'utf8',
  );
}

async function main() {
  const sourceStats = await stat(upstreamSrcRoot);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Upstream source directory not found: ${upstreamSrcRoot}`);
  }

  await writeShims();
  await syncTree();
  await execFileAsync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'prepare-public-runtime.mjs')],
    { cwd: projectRoot },
  );

  process.stdout.write(
    `Synced Actoviq Runtime upstream sources into ${vendorRoot}\n`,
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
