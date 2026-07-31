import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginPackageStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PluginPackageStore', () => {
  it('installs, enables, pins, and removes verified local packages', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plugin-store-'));
    dirs.push(dir);
    const source = path.join(dir, 'source');
    const entry = Buffer.from('export const value = 1;\n');
    await mkdir(source);
    await writeFile(path.join(source, 'index.js'), entry);
    await writeFile(path.join(source, 'hadamard-plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      entry: 'index.js',
      capabilities: ['tools'],
      integrity: `sha256-${createHash('sha256').update(entry).digest('base64')}`,
    }));
    const store = new PluginPackageStore(path.join(dir, 'packages'));
    await store.install(source);
    await store.setEnabled('demo', true);
    await store.pin('demo', '1.0.0');
    expect(await store.list('demo')).toEqual([
      expect.objectContaining({ enabled: true, pinnedVersion: '1.0.0' }),
    ]);
    await store.remove('demo');
    expect(await store.list('demo')).toEqual([]);
  });

  it('rejects package symlinks and replaces same-version installs when entry bits change', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plugin-store-safe-'));
    dirs.push(dir);
    const source = path.join(dir, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'index.js'), 'export const value = 1;\n');
    await writeFile(path.join(source, 'hadamard-plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'safe',
      name: 'Safe',
      version: '1.0.0',
      entry: 'index.js',
      capabilities: ['tools'],
    }));
    const store = new PluginPackageStore(path.join(dir, 'packages'));
    const installed = await store.install(source);
    await writeFile(path.join(source, 'index.js'), 'export const value = 2;\n');
    await store.install(source);
    // Same version with different entry content must not silently keep stale bits.
    expect(await readFile(path.join(installed.packagePath, 'index.js'), 'utf8'))
      .toBe('export const value = 2;\n');

    const linkedSource = path.join(dir, 'linked');
    await mkdir(linkedSource);
    await writeFile(path.join(linkedSource, 'hadamard-plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'linked',
      name: 'Linked',
      version: '1.0.0',
      entry: 'index.js',
      capabilities: [],
    }));
    try {
      await symlink(path.join(source, 'index.js'), path.join(linkedSource, 'index.js'), 'file');
    } catch {
      return;
    }
    await expect(store.install(linkedSource)).rejects.toThrow('symbolic links');
  });
});
