import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../runtime/helpers.js';
import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { parsePluginPackageManifest, type PluginPackageManifest } from './packageManifest.js';

export interface InstalledPluginPackage {
  manifest: PluginPackageManifest;
  packagePath: string;
  enabled: boolean;
  pinnedVersion?: string;
}

export class PluginPackageStore {
  private queue = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  async install(sourceDirectory: string): Promise<InstalledPluginPackage> {
    return this.serial(async () => {
      await assertRegularPackageTree(sourceDirectory);
      const manifest = parsePluginPackageManifest(JSON.parse(
        await readFile(path.join(sourceDirectory, 'actoviq-plugin.json'), 'utf8'),
      ));
      const entry = await readFile(path.resolve(sourceDirectory, manifest.entry));
      if (manifest.integrity) {
        const actual = `sha256-${createHash('sha256').update(entry).digest('base64')}`;
        if (actual !== manifest.integrity) throw new Error('Plugin package integrity mismatch.');
      }
      const target = this.packagePath(manifest.id, manifest.version);
      const existing = await this.readInstalled(target);
      if (existing) {
        if (existing.id !== manifest.id || existing.version !== manifest.version) {
          throw new Error('Installed plugin package identity mismatch.');
        }
        const installedEntry = await readFile(path.resolve(target, existing.entry));
        const sourceHash = createHash('sha256').update(entry).digest('hex');
        const installedHash = createHash('sha256').update(installedEntry).digest('hex');
        if (sourceHash !== installedHash) {
          // Same version id but different bits — refuse to silently reuse a
          // tampered or stale install directory.
          await rm(target, { recursive: true, force: true });
        }
      }
      if (!(await this.readInstalled(target))) {
        await mkdir(path.dirname(target), { recursive: true });
        const staging = `${target}.install-${createId()}`;
        try {
          await cp(sourceDirectory, staging, { recursive: true, dereference: false });
          await rename(staging, target);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          if (!(await this.readInstalled(target))) throw error;
        }
      }
      const state = await this.readState();
      state[manifest.id] = {
        enabled: state[manifest.id]?.enabled ?? false,
        pinnedVersion: state[manifest.id]?.pinnedVersion,
      };
      await this.writeState(state);
      const installed = (await this.readInstalled(target)) ?? manifest;
      return {
        manifest: installed,
        packagePath: target,
        enabled: state[manifest.id]!.enabled,
        pinnedVersion: state[manifest.id]!.pinnedVersion,
      };
    });
  }

  async list(pluginId?: string): Promise<InstalledPluginPackage[]> {
    const state = await this.readState();
    const ids = pluginId ? [pluginId] : await directoryNames(this.rootDirectory, 'state.json');
    const packages: InstalledPluginPackage[] = [];
    for (const id of ids) {
      for (const version of await directoryNames(path.join(this.rootDirectory, id))) {
        const packagePath = this.packagePath(id, version);
        try {
          const manifest = parsePluginPackageManifest(JSON.parse(
            await readFile(path.join(packagePath, 'actoviq-plugin.json'), 'utf8'),
          ));
          packages.push({
            manifest,
            packagePath,
            enabled: state[id]?.enabled ?? false,
            pinnedVersion: state[id]?.pinnedVersion,
          });
        } catch {
          // Ignore incomplete package directories.
        }
      }
    }
    return packages;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    await this.serial(async () => {
      const state = await this.readState();
      state[pluginId] = { ...state[pluginId], enabled };
      await this.writeState(state);
    });
  }

  async pin(pluginId: string, version?: string): Promise<void> {
    await this.serial(async () => {
      const state = await this.readState();
      state[pluginId] = { ...state[pluginId], enabled: state[pluginId]?.enabled ?? false, pinnedVersion: version };
      await this.writeState(state);
    });
  }

  async remove(pluginId: string, version?: string): Promise<void> {
    await this.serial(async () => {
      await rm(version ? this.packagePath(pluginId, version) : this.pluginRoot(pluginId), {
        recursive: true,
        force: true,
      });
    });
  }

  private packagePath(pluginId: string, version: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error('Unsafe plugin package path.');
    }
    return path.join(this.rootDirectory, pluginId, version);
  }

  private pluginRoot(pluginId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId)) {
      throw new Error('Unsafe plugin package path.');
    }
    return path.join(this.rootDirectory, pluginId);
  }

  private async readInstalled(target: string): Promise<PluginPackageManifest | undefined> {
    try {
      return parsePluginPackageManifest(JSON.parse(
        await readFile(path.join(target, 'actoviq-plugin.json'), 'utf8'),
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readState(): Promise<Record<string, { enabled: boolean; pinnedVersion?: string }>> {
    try {
      return JSON.parse(await readFile(path.join(this.rootDirectory, 'state.json'), 'utf8')) as Record<string, { enabled: boolean; pinnedVersion?: string }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async writeState(state: Record<string, { enabled: boolean; pinnedVersion?: string }>): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await writeJsonAtomic(path.join(this.rootDirectory, 'state.json'), state);
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

async function directoryNames(root: string, excluded?: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== excluded)
      .map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function assertRegularPackageTree(root: string): Promise<void> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Plugin package source must be a regular directory.');
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin packages cannot contain symbolic links: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      await assertRegularPackageTree(candidate);
    } else if (!entry.isFile()) {
      throw new Error(`Plugin packages cannot contain special files: ${entry.name}`);
    }
  }
}
