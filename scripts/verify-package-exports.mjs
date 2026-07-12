import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

for (const [subpath, definition] of Object.entries(packageJson.exports ?? {})) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError(`Package export ${subpath} must declare types and default targets.`);
  }
  const typesTarget = definition.types;
  const runtimeTarget = definition.default;
  if (typeof typesTarget !== 'string' || typeof runtimeTarget !== 'string') {
    throw new TypeError(`Package export ${subpath} must declare string types/default targets.`);
  }
  await assertExportFile(subpath, 'types', typesTarget);
  await assertExportFile(subpath, 'default', runtimeTarget);

  const specifier = subpath === '.'
    ? packageJson.name
    : `${packageJson.name}${subpath.slice(1)}`;
  const loaded = await import(specifier);
  if (Reflect.ownKeys(loaded).length === 0) {
    throw new Error(`Package export ${specifier} has no runtime exports.`);
  }
}

console.log(`Verified ${Object.keys(packageJson.exports ?? {}).length} package subpath exports.`);

async function assertExportFile(subpath, condition, target) {
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Package export ${subpath}.${condition} escapes the package root.`);
  }
  await access(resolved).catch(error => {
    throw new Error(`Missing ${condition} target for ${subpath}: ${target}`, { cause: error });
  });
}
