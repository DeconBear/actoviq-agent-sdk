import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginTrustStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PluginTrustStore', () => {
  it('invalidates trust when version, integrity, or capabilities change', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-plugin-trust-'));
    dirs.push(dir);
    const trust = new PluginTrustStore(path.join(dir, 'trust.json'));
    await trust.trust({
      pluginId: 'demo',
      version: '1.0.0',
      integrity: 'sha256-one',
      capabilities: ['tools'],
    });
    await expect(trust.isTrusted({
      pluginId: 'demo',
      version: '1.0.0',
      integrity: 'sha256-one',
      capabilities: ['tools'],
    })).resolves.toBe(true);
    await expect(trust.isTrusted({
      pluginId: 'demo',
      version: '1.0.1',
      integrity: 'sha256-two',
      capabilities: ['tools', 'network'],
    })).resolves.toBe(false);
  });

  it('rejects trust grants that omit integrity hashes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-plugin-trust-'));
    dirs.push(dir);
    const trust = new PluginTrustStore(path.join(dir, 'trust.json'));
    await expect(trust.trust({
      pluginId: 'demo',
      version: '1.0.0',
      capabilities: ['tools'],
    })).rejects.toThrow(/integrity/);
    await expect(trust.isTrusted({
      pluginId: 'demo',
      version: '1.0.0',
      capabilities: ['tools'],
    })).resolves.toBe(false);
  });
});
