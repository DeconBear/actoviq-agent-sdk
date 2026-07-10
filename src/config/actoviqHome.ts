import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';

export interface ActoviqHomeMigrationSummary {
  sourceRoot: string;
  targetRoot: string;
  bytes: number;
  entries: number;
}

export interface MigrateActoviqHomeOptions {
  sourceRoot?: string;
  targetRoot: string;
  osHomeDir?: string;
  writePointer?: boolean;
}

export interface ResolveActoviqHomeOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  inputKind?: 'auto' | 'home' | 'dataRoot';
  osHomeDir?: string;
}

const DATA_ROOT_POINTER = 'data-root.json';

export function defaultActoviqHome(osHomeDir: string = os.homedir()): string {
  return path.join(path.resolve(osHomeDir), '.actoviq');
}

/**
 * Resolve Actoviq's data root.
 *
 * Compatibility note: most existing callers pass an OS home directory as
 * `homeDir`; keep that behavior by appending `.actoviq` for explicit input.
 * `ACTOVIQ_HOME` and `data-root.json` are treated as direct data-root paths.
 */
export function resolveActoviqHome(homeDir?: string, options: ResolveActoviqHomeOptions = {}): string {
  if (homeDir && homeDir.trim()) return resolveHomeDirInput(homeDir, options);
  const env = options.env ?? process.env;
  const envRoot = env.ACTOVIQ_HOME?.trim();
  if (envRoot) return path.resolve(envRoot);
  const defaultRoot = defaultActoviqHome(options.osHomeDir);
  return readBootstrapRoot(defaultRoot) ?? defaultRoot;
}

export function getActoviqHomePointerPath(osHomeDir: string = os.homedir()): string {
  return path.join(defaultActoviqHome(osHomeDir), DATA_ROOT_POINTER);
}

export function summarizeActoviqHome(root: string): ActoviqHomeMigrationSummary {
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) {
    return { sourceRoot: resolved, targetRoot: '', bytes: 0, entries: 0 };
  }
  const totals = walkStatsSync(resolved);
  return { sourceRoot: resolved, targetRoot: '', bytes: totals.bytes, entries: totals.entries };
}

export function listActoviqHomeTopLevelEntries(root: string): string[] {
  try {
    return readdirSync(path.resolve(root), { withFileTypes: true })
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function migrateActoviqHomeData(
  options: MigrateActoviqHomeOptions,
): Promise<ActoviqHomeMigrationSummary> {
  const sourceRoot = path.resolve(options.sourceRoot ?? resolveActoviqHome());
  const targetRoot = path.resolve(options.targetRoot);
  if (samePath(sourceRoot, targetRoot)) {
    throw new Error('Target data root is the same as the current Actoviq data root');
  }
  if (isChildPath(targetRoot, sourceRoot)) {
    throw new Error('Target data root cannot be inside the current Actoviq data root');
  }
  await assertEmptyOrMissingDirectory(targetRoot);
  await mkdir(path.dirname(targetRoot), { recursive: true });
  const sourceExists = await exists(sourceRoot);
  const sourceTotals = sourceExists
    ? await walkStats(sourceRoot)
    : { bytes: 0, entries: 0 };
  if (sourceExists) {
    await cp(sourceRoot, targetRoot, { recursive: true, errorOnExist: false, force: false });
  } else {
    await mkdir(targetRoot, { recursive: true });
  }
  await assertWritableDirectory(targetRoot);
  const totals = await walkStats(targetRoot);
  if (totals.bytes !== sourceTotals.bytes || totals.entries !== sourceTotals.entries) {
    throw new Error(
      `Actoviq data-root validation failed after copy: expected ${sourceTotals.entries} entries/${sourceTotals.bytes} bytes, got ${totals.entries} entries/${totals.bytes} bytes`,
    );
  }
  if (options.writePointer !== false) {
    await writeActoviqHomePointer(targetRoot, options.osHomeDir);
  }
  return { sourceRoot, targetRoot, bytes: totals.bytes, entries: totals.entries };
}

export async function writeActoviqHomePointer(
  targetRoot: string,
  osHomeDir: string = os.homedir(),
): Promise<string> {
  const pointerPath = getActoviqHomePointerPath(osHomeDir);
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, `${JSON.stringify({ root: path.resolve(targetRoot) }, null, 2)}\n`, 'utf8');
  return pointerPath;
}

function resolveHomeDirInput(homeDir: string, options: ResolveActoviqHomeOptions): string {
  const resolved = path.normalize(homeDir);
  if (options.inputKind === 'dataRoot') return resolved;
  if (options.inputKind !== 'home' && isKnownDataRoot(resolved, options)) return resolved;
  return path.basename(resolved).toLowerCase() === '.actoviq'
    ? resolved
    : path.join(resolved, '.actoviq');
}

function isKnownDataRoot(resolved: string, options: ResolveActoviqHomeOptions): boolean {
  const env = options.env ?? process.env;
  const envRoot = env.ACTOVIQ_HOME?.trim();
  if (envRoot && samePath(resolved, envRoot)) return true;
  const pointerRoot = readBootstrapRoot(defaultActoviqHome(options.osHomeDir));
  if (pointerRoot && samePath(resolved, pointerRoot)) return true;
  return hasActoviqDataRootMarker(resolved);
}

function hasActoviqDataRootMarker(root: string): boolean {
  const markerNames = [
    'projects',
    'bridge-configs.json',
    'mcp.json',
    'workspaces.json',
    'history.jsonl',
    'pricing.json',
    'session-memory',
  ];
  if (markerNames.some(name => existsSync(path.join(root, name)))) return true;
  const settingsPath = path.join(root, 'settings.json');
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    return Boolean(
      record.env ||
      record.gui ||
      Object.keys(record).some(key => key.startsWith('ACTOVIQ_')),
    );
  } catch {
    return false;
  }
}

function readBootstrapRoot(defaultRoot: string): string | undefined {
  const pointerPath = path.join(defaultRoot, DATA_ROOT_POINTER);
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { root?: unknown }).root === 'string' &&
      (parsed as { root: string }).root.trim()
    ) {
      return path.resolve((parsed as { root: string }).root);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function assertEmptyOrMissingDirectory(targetRoot: string): Promise<void> {
  try {
    const st = await stat(targetRoot);
    if (!st.isDirectory()) throw new Error(`Target data root is not a directory: ${targetRoot}`);
    const entries = await readdir(targetRoot);
    if (entries.length > 0) throw new Error(`Target data root must be empty: ${targetRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function assertWritableDirectory(targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  const probe = path.join(targetRoot, `.write-test-${process.pid}-${Date.now()}`);
  await writeFile(probe, 'ok', 'utf8');
  try {
    await rm(probe, { force: true });
  } catch {
    // A stale probe is harmless; write success is the validation that matters.
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function walkStatsSync(root: string): { bytes: number; entries: number } {
  let bytes = 0;
  let entries = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    entries += 1;
    if (entry.isDirectory()) {
      const child = walkStatsSync(full);
      bytes += child.bytes;
      entries += child.entries;
    } else {
      bytes += statSync(full).size;
    }
  }
  return { bytes, entries };
}

async function walkStats(root: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    entries += 1;
    if (entry.isDirectory()) {
      const child = await walkStats(full);
      bytes += child.bytes;
      entries += child.entries;
    } else {
      bytes += (await stat(full)).size;
    }
  }
  return { bytes, entries };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isChildPath(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
