import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../runtime/helpers.js';

export interface ActoviqPluginCatalogEntry {
  name: string;
  path: string;
  description?: string;
  version?: string;
  capabilities: string[];
}

export async function discoverActoviqPlugins(options: {
  workDir: string;
  homeDir: string;
  configuredDirs?: string[];
}): Promise<ActoviqPluginCatalogEntry[]> {
  const candidates = [
    path.join(options.homeDir, '.actoviq', 'plugins'),
    path.join(options.workDir, '.actoviq', 'plugins'),
    ...(options.configuredDirs ?? []),
  ];
  const roots = [...new Set(candidates.map(candidate => path.resolve(candidate)))];
  const entries = new Map<string, ActoviqPluginCatalogEntry>();

  for (const root of roots) {
    const direct = await readPlugin(root);
    if (direct) {
      entries.set(direct.path, direct);
      continue;
    }
    let children;
    try {
      children = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const plugin = await readPlugin(path.join(root, child.name));
      if (plugin) entries.set(plugin.path, plugin);
    }
  }

  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readPlugin(root: string): Promise<ActoviqPluginCatalogEntry | undefined> {
  const manifestPaths = [
    path.join(root, '.actoviq-plugin', 'plugin.json'),
    path.join(root, 'plugin.json'),
  ];
  for (const manifestPath of manifestPaths) {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!isRecord(parsed)) continue;
      return {
        name: typeof parsed.name === 'string' ? parsed.name : path.basename(root),
        path: root,
        description: typeof parsed.description === 'string' ? parsed.description : undefined,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        capabilities: await detectCapabilities(root),
      };
    } catch {
      // Try the next supported manifest location.
    }
  }
  return undefined;
}

async function detectCapabilities(root: string): Promise<string[]> {
  const candidates = [
    ['skills', path.join(root, 'skills')],
    ['agents', path.join(root, 'agents')],
    ['mcp', path.join(root, 'mcp.json')],
    ['hooks', path.join(root, 'hooks')],
  ] as const;
  const capabilities: string[] = [];
  for (const [name, candidate] of candidates) {
    try {
      await stat(candidate);
      capabilities.push(name);
    } catch {
      // Optional capability is absent.
    }
  }
  return capabilities;
}
