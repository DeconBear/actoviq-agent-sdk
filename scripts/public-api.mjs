import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const update = process.argv.includes('--update');
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const snapshotPath = path.join(root, 'etc', 'public-api.json');
const declarationFiles = await findDeclarationFiles(path.join(root, 'dist', 'src'));
if (declarationFiles.length === 0) {
  throw new Error('No declarations found under dist/src. Run npm run build first.');
}

const program = ts.createProgram(declarationFiles, {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const snapshot = { schemaVersion: 1, exports: {} };

for (const [subpath, definition] of Object.entries(packageJson.exports ?? {})) {
  if (!definition || typeof definition !== 'object' || typeof definition.types !== 'string') {
    throw new TypeError(`Package export ${subpath} has no declaration target.`);
  }
  const entryPath = path.resolve(root, definition.types);
  const source = program.getSourceFile(entryPath);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!source || !moduleSymbol) {
    throw new Error(`Cannot inspect declaration entry for ${subpath}: ${definition.types}`);
  }
  const entries = checker.getExportsOfModule(moduleSymbol)
    .map(exported => describeExport(exported, source))
    .sort((left, right) => left.name.localeCompare(right.name));
  snapshot.exports[subpath] = entries;
}

const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
if (update) {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, serialized, 'utf8');
  console.log(`Updated public API snapshot: ${path.relative(root, snapshotPath)}`);
} else {
  const expected = await readFile(snapshotPath, 'utf8').catch(() => undefined);
  if (expected === undefined) {
    throw new Error('Public API snapshot is missing. Run npm run api:update intentionally.');
  }
  if (expected !== serialized) {
    reportDiff(JSON.parse(expected), snapshot);
    throw new Error('Public API changed. Review it, then run npm run api:update intentionally.');
  }
  console.log(`Public API snapshot matches ${Object.keys(snapshot.exports).length} subpaths.`);
}

function describeExport(exported, entrySource) {
  const target = exported.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(exported)
    : exported;
  const declarations = (target.declarations ?? [])
    .filter(declaration => declaration.getSourceFile().isDeclarationFile)
    .map(declaration => normalizeDeclaration(printer.printNode(
      ts.EmitHint.Unspecified,
      declaration,
      declaration.getSourceFile(),
    )))
    .filter(Boolean)
    .sort();
  let signature = declarations.join('\n');
  if (!signature) {
    const location = target.valueDeclaration ?? target.declarations?.[0] ?? entrySource;
    signature = checker.typeToString(
      checker.getTypeOfSymbolAtLocation(target, location),
      location,
      ts.TypeFormatFlags.NoTruncation,
    );
  }
  return {
    name: exported.getName(),
    kind: symbolKind(target),
    signature,
  };
}

function normalizeDeclaration(value) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

function symbolKind(symbol) {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.NamespaceModule) return 'namespace';
  if (flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.FunctionScopedVariable)) {
    return 'value';
  }
  return 'other';
}

function reportDiff(expected, actual) {
  const subpaths = new Set([
    ...Object.keys(expected.exports ?? {}),
    ...Object.keys(actual.exports ?? {}),
  ]);
  for (const subpath of [...subpaths].sort()) {
    const before = new Map((expected.exports?.[subpath] ?? []).map(entry => [entry.name, entry]));
    const after = new Map((actual.exports?.[subpath] ?? []).map(entry => [entry.name, entry]));
    const added = [...after.keys()].filter(name => !before.has(name));
    const removed = [...before.keys()].filter(name => !after.has(name));
    const changed = [...after.keys()].filter(name => {
      const previous = before.get(name);
      return previous && JSON.stringify(previous) !== JSON.stringify(after.get(name));
    });
    if (added.length || removed.length || changed.length) {
      console.error(`${subpath}: added=[${added.join(', ')}] removed=[${removed.join(', ')}] changed=[${changed.join(', ')}]`);
    }
  }
}

async function findDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return findDeclarationFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.d.ts') ? [absolute] : [];
  }));
  return nested.flat();
}
