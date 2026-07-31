import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';

export interface HadamardHomeMigrationSummary {
  sourceRoot: string;
  targetRoot: string;
  bytes: number;
  entries: number;
}

export interface MigrateHadamardHomeOptions {
  sourceRoot?: string;
  targetRoot: string;
  osHomeDir?: string;
  writePointer?: boolean;
}

export interface ResolveHadamardHomeOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  inputKind?: 'auto' | 'home' | 'dataRoot';
  osHomeDir?: string;
}

const DATA_ROOT_POINTER = 'data-root.json';

export function defaultHadamardHome(osHomeDir: string = os.homedir()): string {
  return path.join(path.resolve(osHomeDir), '.hadamard');
}

export function defaultLegacyActoviqHome(osHomeDir: string = os.homedir()): string {
  return path.join(path.resolve(osHomeDir), '.actoviq');
}

/**
 * Resolve Hadamard's data root.
 *
 * Compatibility note: most existing callers pass an OS home directory as
 * `homeDir`; keep that behavior by appending `.hadamard` for explicit input.
 * `HADAMARD_HOME` and `data-root.json` are treated as direct data-root paths.
 * Legacy `ACTOVIQ_HOME` / `~/.actoviq` remain readable until migrated.
 */
export function resolveHadamardHome(homeDir?: string, options: ResolveHadamardHomeOptions = {}): string {
  if (homeDir && homeDir.trim()) return resolveHomeDirInput(homeDir, options);
  const env = options.env ?? process.env;
  const envRoot = env.HADAMARD_HOME?.trim() || env.ACTOVIQ_HOME?.trim();
  if (envRoot) return path.resolve(envRoot);
  const defaultRoot = defaultHadamardHome(options.osHomeDir);
  const pointed = readBootstrapRoot(defaultRoot);
  if (pointed) return pointed;
  if (existsSync(defaultRoot)) return defaultRoot;
  const legacyRoot = defaultLegacyActoviqHome(options.osHomeDir);
  if (existsSync(legacyRoot)) return legacyRoot;
  return defaultRoot;
}

/**
 * One-shot copy of legacy `~/.actoviq` into `~/.hadamard` when the new root is
 * missing/empty. Keeps the old directory intact as a backup.
 */
export async function migrateLegacyActoviqHomeIfNeeded(
  osHomeDir: string = os.homedir(),
): Promise<HadamardHomeMigrationSummary | undefined> {
  const targetRoot = defaultHadamardHome(osHomeDir);
  const sourceRoot = defaultLegacyActoviqHome(osHomeDir);
  if (!existsSync(sourceRoot)) return undefined;
  if (existsSync(targetRoot)) {
    try {
      const entries = readdirSync(targetRoot);
      if (entries.length > 0) return undefined;
    } catch {
      return undefined;
    }
  }
  return migrateHadamardHomeData({
    sourceRoot,
    targetRoot,
    osHomeDir,
    writePointer: false,
  });
}

/**
 * Rename a project-local `.actoviq/` directory to `.hadamard/` when the new
 * name is missing. Leaves `.actoviq` alone if `.hadamard` already exists.
 */
export async function migrateLegacyProjectActoviqDirIfNeeded(
  workDir: string,
): Promise<{ sourceRoot: string; targetRoot: string } | undefined> {
  const resolved = path.resolve(workDir);
  const sourceRoot = path.join(resolved, '.actoviq');
  const targetRoot = path.join(resolved, '.hadamard');
  if (!existsSync(sourceRoot)) return undefined;
  if (existsSync(targetRoot)) return undefined;
  await cp(sourceRoot, targetRoot, { recursive: true, errorOnExist: true, force: false });
  await rm(sourceRoot, { recursive: true, force: true });
  return { sourceRoot, targetRoot };
}

export function getHadamardHomePointerPath(osHomeDir: string = os.homedir()): string {
  return path.join(defaultHadamardHome(osHomeDir), DATA_ROOT_POINTER);
}

export function summarizeHadamardHome(root: string): HadamardHomeMigrationSummary {
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) {
    return { sourceRoot: resolved, targetRoot: '', bytes: 0, entries: 0 };
  }
  const totals = walkStatsSync(resolved);
  return { sourceRoot: resolved, targetRoot: '', bytes: totals.bytes, entries: totals.entries };
}

export function listHadamardHomeTopLevelEntries(root: string): string[] {
  try {
    return readdirSync(path.resolve(root), { withFileTypes: true })
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function migrateHadamardHomeData(
  options: MigrateHadamardHomeOptions,
): Promise<HadamardHomeMigrationSummary> {
  const sourceRoot = path.resolve(options.sourceRoot ?? resolveHadamardHome());
  const targetRoot = path.resolve(options.targetRoot);
  if (samePath(sourceRoot, targetRoot)) {
    throw new Error('Target data root is the same as the current Hadamard data root');
  }
  if (isChildPath(targetRoot, sourceRoot)) {
    throw new Error('Target data root cannot be inside the current Hadamard data root');
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
      `Hadamard data-root validation failed after copy: expected ${sourceTotals.entries} entries/${sourceTotals.bytes} bytes, got ${totals.entries} entries/${totals.bytes} bytes`,
    );
  }
  if (options.writePointer !== false) {
    await writeHadamardHomePointer(targetRoot, options.osHomeDir);
  }
  return { sourceRoot, targetRoot, bytes: totals.bytes, entries: totals.entries };
}

export async function writeHadamardHomePointer(
  targetRoot: string,
  osHomeDir: string = os.homedir(),
): Promise<string> {
  const pointerPath = getHadamardHomePointerPath(osHomeDir);
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, `${JSON.stringify({ root: path.resolve(targetRoot) }, null, 2)}\n`, 'utf8');
  return pointerPath;
}

function resolveHomeDirInput(homeDir: string, options: ResolveHadamardHomeOptions): string {
  const resolved = path.normalize(homeDir);
  if (options.inputKind === 'dataRoot') return resolved;
  if (options.inputKind !== 'home' && isKnownDataRoot(resolved, options)) return resolved;
  const base = path.basename(resolved).toLowerCase();
  if (base === '.hadamard' || base === '.actoviq') return resolved;
  return path.join(resolved, '.hadamard');
}

function isKnownDataRoot(resolved: string, options: ResolveHadamardHomeOptions): boolean {
  const env = options.env ?? process.env;
  const envRoot = env.HADAMARD_HOME?.trim() || env.ACTOVIQ_HOME?.trim();
  if (envRoot && samePath(resolved, envRoot)) return true;
  const pointerRoot = readBootstrapRoot(defaultHadamardHome(options.osHomeDir));
  if (pointerRoot && samePath(resolved, pointerRoot)) return true;
  return hasHadamardDataRootMarker(resolved);
}

function hasHadamardDataRootMarker(root: string): boolean {
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
      Object.keys(record).some(key => key.startsWith('HADAMARD_') || key.startsWith('ACTOVIQ_')),
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
