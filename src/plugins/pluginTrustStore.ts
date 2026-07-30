import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';

export interface PluginTrustGrant {
  pluginId: string;
  version: string;
  integrity?: string;
  capabilities: string[];
  trustedAt: string;
}

export class PluginTrustStore {
  constructor(private readonly filePath: string) {}

  async trust(grant: Omit<PluginTrustGrant, 'trustedAt'>): Promise<PluginTrustGrant> {
    if (!grant.integrity?.trim()) {
      throw new Error('Plugin trust requires a non-empty integrity hash.');
    }
    const state = await this.read();
    const trusted: PluginTrustGrant = { ...grant, trustedAt: new Date().toISOString() };
    state[grant.pluginId] = trusted;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, state);
    return trusted;
  }

  async revoke(pluginId: string): Promise<void> {
    const state = await this.read();
    delete state[pluginId];
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, state);
  }

  async isTrusted(input: Omit<PluginTrustGrant, 'trustedAt'>): Promise<boolean> {
    const grant = (await this.read())[input.pluginId];
    if (!grant || grant.version !== input.version) return false;
    // Integrity is mandatory — missing hashes must never count as trusted.
    if (!grant.integrity || !input.integrity || grant.integrity !== input.integrity) {
      return false;
    }
    return input.capabilities.every(capability => grant.capabilities.includes(capability));
  }

  private async read(): Promise<Record<string, PluginTrustGrant>> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, PluginTrustGrant>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}
