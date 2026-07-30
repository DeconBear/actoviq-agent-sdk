import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveActoviqHome } from '../config/actoviqHome.js';

export type WorkspaceRegistryEntry = {
  /** Stable primary path used as the project's storage/catalog locator. */
  path: string;
  /** All work paths belonging to this project, including `path`. */
  workPaths?: string[];
  /** Work path most recently selected inside this project. */
  activeWorkPath?: string;
  lastOpenedAt: string;
  /** When true, the workspace stays pinned at the top of the sidebar recents list. */
  pinned?: boolean;
};

function registryPath(homeDir: string): string {
  return path.join(resolveActoviqHome(homeDir), 'workspaces.json');
}

function normalizeKey(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isEntry(value: unknown): value is WorkspaceRegistryEntry {
  return typeof value === 'object'
    && value !== null
    && typeof (value as WorkspaceRegistryEntry).path === 'string'
    && typeof (value as WorkspaceRegistryEntry).lastOpenedAt === 'string';
}

function uniqueResolvedPaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const resolved = path.resolve(value.trim());
    const key = normalizeKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function normalizeEntry(item: WorkspaceRegistryEntry): WorkspaceRegistryEntry {
  const resolved = path.resolve(item.path.trim());
  const workPaths = uniqueResolvedPaths([
    resolved,
    ...(Array.isArray(item.workPaths) ? item.workPaths : []),
  ]);
  const requestedActive = typeof item.activeWorkPath === 'string'
    ? path.resolve(item.activeWorkPath)
    : resolved;
  const activeWorkPath = workPaths.find(candidate =>
    normalizeKey(candidate) === normalizeKey(requestedActive)
  ) ?? resolved;
  return {
    path: resolved,
    ...(workPaths.length > 1 ? { workPaths } : {}),
    ...(normalizeKey(activeWorkPath) !== normalizeKey(resolved) ? { activeWorkPath } : {}),
    lastOpenedAt: item.lastOpenedAt,
    ...(item.pinned === true ? { pinned: true } : {}),
  };
}

export async function readWorkspaceRegistry(homeDir: string): Promise<WorkspaceRegistryEntry[]> {
  try {
    const raw = JSON.parse(await readFile(registryPath(homeDir), 'utf8')) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : (typeof raw === 'object' && raw !== null && Array.isArray((raw as { workspaces?: unknown }).workspaces)
        ? (raw as { workspaces: unknown[] }).workspaces
        : []);
    const seenProjects = new Set<string>();
    const seenWorkPaths = new Set<string>();
    const entries: WorkspaceRegistryEntry[] = [];
    for (const item of list) {
      if (!isEntry(item) || !item.path.trim()) continue;
      const entry = normalizeEntry(item);
      const key = normalizeKey(entry.path);
      if (seenProjects.has(key)) continue;
      const ownedPaths = workspaceWorkPaths(entry);
      if (ownedPaths.some(candidate => seenWorkPaths.has(normalizeKey(candidate)))) continue;
      seenProjects.add(key);
      for (const candidate of ownedPaths) seenWorkPaths.add(normalizeKey(candidate));
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

export function workspaceWorkPaths(entry: WorkspaceRegistryEntry): string[] {
  return uniqueResolvedPaths([
    entry.path,
    ...(Array.isArray(entry.workPaths) ? entry.workPaths : []),
  ]);
}

export function workspaceActiveWorkPath(entry: WorkspaceRegistryEntry): string {
  const paths = workspaceWorkPaths(entry);
  const requested = typeof entry.activeWorkPath === 'string' ? path.resolve(entry.activeWorkPath) : entry.path;
  return paths.find(candidate => normalizeKey(candidate) === normalizeKey(requested)) ?? paths[0]!;
}

export function findWorkspaceProject(
  entries: WorkspaceRegistryEntry[],
  workPath: string,
): WorkspaceRegistryEntry | undefined {
  const key = normalizeKey(path.resolve(workPath));
  return entries.find(entry =>
    workspaceWorkPaths(entry).some(candidate => normalizeKey(candidate) === key)
  );
}

async function writeWorkspaceRegistry(homeDir: string, entries: WorkspaceRegistryEntry[]): Promise<void> {
  const filePath = registryPath(homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ workspaces: entries }, null, 2)}\n`, 'utf8');
}

export async function rememberWorkspace(
  workDir: string,
  homeDir: string,
  openedAt = new Date().toISOString(),
): Promise<WorkspaceRegistryEntry[]> {
  const resolved = path.resolve(workDir);
  const existing = await readWorkspaceRegistry(homeDir);
  const prev = findWorkspaceProject(existing, resolved);
  const primaryPath = prev?.path ?? resolved;
  const next = existing.filter((entry) => normalizeKey(entry.path) !== normalizeKey(primaryPath));
  next.unshift({
    path: primaryPath,
    ...(prev?.workPaths ? { workPaths: workspaceWorkPaths(prev) } : {}),
    ...(normalizeKey(resolved) !== normalizeKey(primaryPath) ? { activeWorkPath: resolved } : {}),
    lastOpenedAt: openedAt,
    ...(prev?.pinned ? { pinned: true } : {}),
  });
  next.sort((a, b) => {
    const ap = a.pinned === true ? 1 : 0;
    const bp = b.pinned === true ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
  });
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}

export async function setWorkspacePinned(
  workDir: string,
  homeDir: string,
  pinned: boolean,
): Promise<WorkspaceRegistryEntry[]> {
  const resolved = path.resolve(workDir);
  const existing = await readWorkspaceRegistry(homeDir);
  const project = findWorkspaceProject(existing, resolved);
  const key = normalizeKey(project?.path ?? resolved);
  let found = false;
  const next: WorkspaceRegistryEntry[] = existing.map((entry) => {
    if (normalizeKey(entry.path) !== key) return entry;
    found = true;
    if (pinned) return { ...entry, pinned: true as const };
    const { pinned: _pinned, ...rest } = entry;
    return rest;
  });
  if (!found) {
    next.unshift({
      path: path.resolve(workDir),
      lastOpenedAt: new Date().toISOString(),
      ...(pinned ? { pinned: true as const } : {}),
    });
  }
  // Keep pinned workspaces first (stable among pins by lastOpenedAt), then unpinned.
  next.sort((a, b) => {
    const ap = a.pinned === true ? 1 : 0;
    const bp = b.pinned === true ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
  });
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}

export async function forgetWorkspaceFromRegistry(
  workDir: string,
  homeDir: string,
): Promise<WorkspaceRegistryEntry[]> {
  const existing = await readWorkspaceRegistry(homeDir);
  const project = findWorkspaceProject(existing, workDir);
  const key = normalizeKey(project?.path ?? path.resolve(workDir));
  const next = existing
    .filter((entry) => normalizeKey(entry.path) !== key);
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}

export async function addProjectWorkPath(
  projectPath: string,
  workPath: string,
  homeDir: string,
  options: { activate?: boolean; openedAt?: string } = {},
): Promise<WorkspaceRegistryEntry[]> {
  const primary = path.resolve(projectPath);
  const additional = path.resolve(workPath);
  const existing = await readWorkspaceRegistry(homeDir);
  const project = findWorkspaceProject(existing, primary);
  if (!project || normalizeKey(project.path) !== normalizeKey(primary)) {
    throw new Error(`Project is not registered: ${primary}`);
  }
  const owner = findWorkspaceProject(existing, additional);
  if (owner && normalizeKey(owner.path) !== normalizeKey(primary)) {
    throw new Error(`Work path already belongs to another project: ${additional}`);
  }
  const workPaths = uniqueResolvedPaths([...workspaceWorkPaths(project), additional]);
  const nextEntry = normalizeEntry({
    ...project,
    workPaths,
    activeWorkPath: options.activate === true ? additional : workspaceActiveWorkPath(project),
    lastOpenedAt: options.openedAt ?? project.lastOpenedAt,
  });
  const next = existing.map(entry =>
    normalizeKey(entry.path) === normalizeKey(primary) ? nextEntry : entry
  );
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}

export async function removeProjectWorkPath(
  projectPath: string,
  workPath: string,
  homeDir: string,
): Promise<WorkspaceRegistryEntry[]> {
  const primary = path.resolve(projectPath);
  const target = path.resolve(workPath);
  if (normalizeKey(primary) === normalizeKey(target)) {
    throw new Error('The primary project path cannot be removed.');
  }
  const existing = await readWorkspaceRegistry(homeDir);
  const project = findWorkspaceProject(existing, primary);
  if (!project || normalizeKey(project.path) !== normalizeKey(primary)) {
    throw new Error(`Project is not registered: ${primary}`);
  }
  const workPaths = workspaceWorkPaths(project)
    .filter(candidate => normalizeKey(candidate) !== normalizeKey(target));
  if (workPaths.length === workspaceWorkPaths(project).length) {
    throw new Error(`Work path is not part of the project: ${target}`);
  }
  const activeWorkPath = normalizeKey(workspaceActiveWorkPath(project)) === normalizeKey(target)
    ? primary
    : workspaceActiveWorkPath(project);
  const nextEntry = normalizeEntry({ ...project, workPaths, activeWorkPath });
  const next = existing.map(entry =>
    normalizeKey(entry.path) === normalizeKey(primary) ? nextEntry : entry
  );
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}

export async function setProjectActiveWorkPath(
  projectPath: string,
  workPath: string,
  homeDir: string,
  openedAt = new Date().toISOString(),
): Promise<WorkspaceRegistryEntry[]> {
  const primary = path.resolve(projectPath);
  const target = path.resolve(workPath);
  const existing = await readWorkspaceRegistry(homeDir);
  const project = findWorkspaceProject(existing, primary);
  if (!project || normalizeKey(project.path) !== normalizeKey(primary)) {
    throw new Error(`Project is not registered: ${primary}`);
  }
  if (!workspaceWorkPaths(project).some(candidate => normalizeKey(candidate) === normalizeKey(target))) {
    throw new Error(`Work path is not part of the project: ${target}`);
  }
  const nextEntry = normalizeEntry({
    ...project,
    activeWorkPath: target,
    lastOpenedAt: openedAt,
  });
  const next = existing.map(entry =>
    normalizeKey(entry.path) === normalizeKey(primary) ? nextEntry : entry
  );
  next.sort((a, b) => {
    const ap = a.pinned === true ? 1 : 0;
    const bp = b.pinned === true ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
  });
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}
