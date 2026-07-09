import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceRegistryEntry = {
  path: string;
  lastOpenedAt: string;
};

function registryPath(homeDir: string): string {
  return path.join(homeDir, '.actoviq', 'workspaces.json');
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
      const resolved = path.resolve(item.path.trim());
      const key = normalizeKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ path: resolved, lastOpenedAt: item.lastOpenedAt });
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
  const next = existing.filter((entry) => normalizeKey(entry.path) !== key);
  next.unshift({ path: resolved, lastOpenedAt: openedAt });
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
