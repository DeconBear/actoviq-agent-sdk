import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverHadamardPlugins } from '../src/tui/pluginCatalog.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Clean plugin catalog', () => {
  it('discovers user, project, and configured plugin manifests with capabilities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plugin-catalog-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const pluginDir = path.join(workDir, '.hadamard', 'plugins', 'release-tools');
    await mkdir(path.join(pluginDir, '.hadamard-plugin'), { recursive: true });
    await mkdir(path.join(pluginDir, 'skills'), { recursive: true });
    await writeFile(
      path.join(pluginDir, '.hadamard-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'release-tools',
        version: '1.0.0',
        description: 'Release workflow extensions',
      }),
    );

    const plugins = await discoverHadamardPlugins({ homeDir, workDir });

    expect(plugins).toEqual([
      expect.objectContaining({
        name: 'release-tools',
        version: '1.0.0',
        capabilities: ['skills'],
      }),
    ]);
  });
});
