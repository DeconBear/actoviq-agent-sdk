import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginPackageManager, type ResolvedPolicy } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PluginPackageManager managed policy', () => {
  it('rejects a disallowed publisher or capability before installation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plugin-policy-'));
    dirs.push(dir);
    const source = path.join(dir, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'index.js'), 'export default {};\n', 'utf8');
    await writeFile(path.join(source, 'hadamard-plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      publisher: 'untrusted.example',
      entry: 'index.js',
      capabilities: ['network'],
    }), 'utf8');
    const policy: ResolvedPolicy = {
      settings: {
        plugins: {
          allowedPublishers: ['trusted.example'],
          allowedCapabilities: ['tools'],
        },
      },
      rules: [],
      lockedSettings: ['plugins'],
      sources: ['host'],
    };
    const manager = new PluginPackageManager(path.join(dir, 'installed'), undefined, policy);

    await expect(manager.execute(`install ${source}`)).rejects.toThrow('publisher is blocked');
    await expect(manager.packages.list()).resolves.toEqual([]);
  });
});
