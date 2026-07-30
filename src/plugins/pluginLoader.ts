import { pathToFileURL } from 'node:url';
import path from 'node:path';

import type { PluginPackageStore } from './pluginPackageStore.js';
import { resolvePluginVersion } from './pluginResolver.js';
import type { PluginTrustStore } from './pluginTrustStore.js';

export class PluginLoader {
  constructor(
    private readonly store: PluginPackageStore,
    private readonly trust: PluginTrustStore,
  ) {}

  async load(pluginId: string): Promise<unknown> {
    const packages = await this.store.list(pluginId);
    const manifest = resolvePluginVersion(
      packages.map(item => item.manifest),
      { pinnedVersion: packages[0]?.pinnedVersion },
    );
    const selected = packages.find(item => item.manifest.version === manifest?.version);
    if (!selected || !selected.enabled) throw new Error(`Plugin "${pluginId}" is not enabled.`);
    const trusted = await this.trust.isTrusted({
      pluginId,
      version: selected.manifest.version,
      integrity: selected.manifest.integrity,
      capabilities: selected.manifest.capabilities,
    });
    if (!trusted) throw new Error(`Plugin "${pluginId}" is not trusted for this version and capability set.`);
    const entry = path.resolve(selected.packagePath, selected.manifest.entry);
    if (path.relative(selected.packagePath, entry).startsWith('..')) {
      throw new Error('Plugin entry escapes the package root.');
    }
    return import(pathToFileURL(entry).href);
  }
}
