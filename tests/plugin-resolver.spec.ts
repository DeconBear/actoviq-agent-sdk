import { describe, expect, it } from 'vitest';

import { resolvePluginVersion, type PluginPackageManifest } from '../src/index.js';

const manifest = (version: string): PluginPackageManifest => ({
  schemaVersion: 1,
  id: 'demo',
  name: 'Demo',
  version,
  entry: 'index.js',
  capabilities: [],
});

describe('plugin resolver', () => {
  it('selects latest by default and honors pins', () => {
    const versions = [manifest('1.2.0'), manifest('2.0.0'), manifest('1.10.0')];
    expect(resolvePluginVersion(versions)?.version).toBe('2.0.0');
    expect(resolvePluginVersion(versions, { pinnedVersion: '1.2.0' })?.version).toBe('1.2.0');
  });
});
