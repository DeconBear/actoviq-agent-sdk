import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedPolicy } from '../policy/types.js';
import { policySetting } from '../policy/runtimePolicy.js';
import {
  parsePluginPackageManifest,
  type PluginPackageManifest,
} from './packageManifest.js';
import { PluginPackageStore } from './pluginPackageStore.js';
import { PluginRegistryClient } from './pluginRegistryClient.js';
import { resolvePluginVersion } from './pluginResolver.js';
import { PluginTrustStore } from './pluginTrustStore.js';

export interface PluginManagerResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
}

export class PluginPackageManager {
  readonly packages: PluginPackageStore;
  readonly trust: PluginTrustStore;

  constructor(
    rootDirectory: string,
    private readonly registryUrl?: string,
    private readonly policy?: ResolvedPolicy,
  ) {
    this.packages = new PluginPackageStore(path.join(rootDirectory, 'packages'));
    this.trust = new PluginTrustStore(path.join(rootDirectory, 'trust.json'));
  }

  async execute(input: string): Promise<PluginManagerResult> {
    const [action = 'list', ...rest] = input.trim().split(/\s+/);
    if (action === 'list') {
      const installed = await this.packages.list();
      return {
        message: `${installed.length} installed plugin package(s).`,
        items: installed.map(item => ({
          label: `${item.manifest.id}@${item.manifest.version}`,
          description: `${item.enabled ? 'enabled' : 'disabled'}${item.pinnedVersion ? ` · pinned ${item.pinnedVersion}` : ''}`,
        })),
      };
    }
    if (action === 'search') {
      if (!this.registryUrl) throw new Error('Set HADAMARD_PLUGIN_REGISTRY to search a registry.');
      this.assertRegistryAllowed();
      const entries = await new PluginRegistryClient(this.registryUrl).search(rest.join(' '));
      entries.forEach(entry => this.assertManifestAllowed(entry.manifest));
      return {
        message: `${entries.length} registry result(s).`,
        items: entries.map(entry => ({
          label: `${entry.manifest.id}@${entry.manifest.version}`,
          description: entry.manifest.description,
        })),
      };
    }
    if (action === 'install' || action === 'update') {
      const source = rest.join(' ').trim();
      if (!source) throw new Error(`Usage: /plugin ${action} <local-package-directory>`);
      const manifest = parsePluginPackageManifest(JSON.parse(
        await readFile(path.join(path.resolve(source), 'hadamard-plugin.json'), 'utf8'),
      ));
      this.assertManifestAllowed(manifest);
      const installed = await this.packages.install(path.resolve(source));
      return { message: `${action === 'install' ? 'Installed' : 'Updated'} ${installed.manifest.id}@${installed.manifest.version}.` };
    }
    const pluginId = rest[0];
    if (!pluginId) throw new Error(`Usage: /plugin ${action} <plugin-id>`);
    if (action === 'enable' || action === 'disable') {
      if (action === 'enable') {
        const installed = await this.packages.list(pluginId);
        installed.forEach(item => this.assertManifestAllowed(item.manifest));
      }
      await this.packages.setEnabled(pluginId, action === 'enable');
      return { message: `${action === 'enable' ? 'Enabled' : 'Disabled'} ${pluginId}.` };
    }
    if (action === 'pin') {
      const version = rest[1] === 'off' ? undefined : rest[1];
      await this.packages.pin(pluginId, version);
      return { message: version ? `Pinned ${pluginId}@${version}.` : `Unpinned ${pluginId}.` };
    }
    if (action === 'remove') {
      await this.packages.remove(pluginId, rest[1]);
      await this.trust.revoke(pluginId);
      return { message: `Removed ${pluginId}${rest[1] ? `@${rest[1]}` : ''}.` };
    }
    if (action === 'trust') {
      const packages = await this.packages.list(pluginId);
      const manifest = resolvePluginVersion(
        packages.map(item => item.manifest),
        { pinnedVersion: packages[0]?.pinnedVersion },
      );
      if (!manifest) throw new Error(`Plugin package not installed: ${pluginId}`);
      this.assertManifestAllowed(manifest);
      await this.trust.trust({
        pluginId,
        version: manifest.version,
        integrity: manifest.integrity,
        capabilities: manifest.capabilities,
      });
      return { message: `Trusted ${pluginId}@${manifest.version} for ${manifest.capabilities.join(', ') || 'no capabilities'}.` };
    }
    throw new Error('Usage: /plugin list|search|install|update|pin|enable|disable|remove|trust');
  }

  private assertRegistryAllowed(): void {
    const allowed = policySetting<string[]>(this.policy ?? emptyPolicy, 'plugins.allowedRegistries');
    if (allowed?.length && this.registryUrl && !allowed.includes(this.registryUrl)) {
      throw new Error(`Plugin registry is blocked by managed policy: ${this.registryUrl}`);
    }
  }

  private assertManifestAllowed(manifest: PluginPackageManifest): void {
    if (!this.policy) return;
    const publishers = policySetting<string[]>(this.policy, 'plugins.allowedPublishers');
    if (publishers?.length && (!manifest.publisher || !publishers.includes(manifest.publisher))) {
      throw new Error(`Plugin publisher is blocked by managed policy: ${manifest.publisher ?? 'unsigned'}`);
    }
    const capabilities = policySetting<string[]>(this.policy, 'plugins.allowedCapabilities');
    const blocked = capabilities?.length
      ? manifest.capabilities.find(capability => !capabilities.includes(capability))
      : undefined;
    if (blocked) throw new Error(`Plugin capability is blocked by managed policy: ${blocked}`);
  }
}

const emptyPolicy: ResolvedPolicy = {
  settings: {},
  rules: [],
  lockedSettings: [],
  sources: [],
};
