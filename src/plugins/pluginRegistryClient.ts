import { parsePluginPackageManifest, type PluginPackageManifest } from './packageManifest.js';

export interface PluginRegistryEntry {
  manifest: PluginPackageManifest;
  downloadUrl: string;
}

export class PluginRegistryClient {
  constructor(private readonly indexUrl: string) {}

  async list(signal?: AbortSignal): Promise<PluginRegistryEntry[]> {
    const response = await fetch(this.indexUrl, { signal });
    if (!response.ok) throw new Error(`Plugin registry request failed: HTTP ${response.status}`);
    const value = await response.json() as unknown;
    if (!Array.isArray(value)) throw new Error('Plugin registry index must be an array.');
    return value.map(item => {
      if (!isRecord(item) || typeof item.downloadUrl !== 'string') {
        throw new Error('Invalid plugin registry entry.');
      }
      return {
        manifest: parsePluginPackageManifest(item.manifest),
        downloadUrl: item.downloadUrl,
      };
    });
  }

  async search(query: string, signal?: AbortSignal): Promise<PluginRegistryEntry[]> {
    const needle = query.trim().toLowerCase();
    return (await this.list(signal)).filter(entry =>
      `${entry.manifest.id} ${entry.manifest.name} ${entry.manifest.description ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
