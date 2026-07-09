import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveActoviqHome } from '../config/actoviqHome.js';

export type WorkspaceRegistryEntry = {
  path: string;
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

function normalizeEntry(item: WorkspaceRegistryEntry): WorkspaceRegistryEntry {
  const resolved = path.resolve(item.path.trim());
  return {
    path: resolved,
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
    const seen = new Set<string>();
    const entries: WorkspaceRegistryEntry[] = [];
    for (const item of list) {
      if (!isEntry(item) || !item.path.trim()) continue;
      const entry = normalizeEntry(item);
      const key = normalizeKey(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
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
  const key = normalizeKey(resolved);
  const existing = await readWorkspaceRegistry(homeDir);
  const prev = existing.find((entry) => normalizeKey(entry.path) === key);
  const next = existing.filter((entry) => normalizeKey(entry.path) !== key);
  next.unshift({
    path: resolved,
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
  const key = normalizeKey(path.resolve(workDir));
  const existing = await readWorkspaceRegistry(homeDir);
  let found = false;
  const next: WorkspaceRegistryEntry[] = existing.map((entry) => {
    if (normalizeKey(entry.path) !== key) return entry;
    found = true;
    if (pinned) return { ...entry, pinned: true as const };
    return { path: entry.path, lastOpenedAt: entry.lastOpenedAt };
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
  const key = normalizeKey(path.resolve(workDir));
  const next = (await readWorkspaceRegistry(homeDir))
    .filter((entry) => normalizeKey(entry.path) !== key);
  await writeWorkspaceRegistry(homeDir, next);
  return next;
}
