import { describe, expect, it } from 'vitest';

import { parsePluginPackageManifest } from '../src/index.js';

describe('plugin package manifest', () => {
  it('validates ids, SemVer, integrity, and package-local entries', () => {
    expect(parsePluginPackageManifest({
      schemaVersion: 1,
      id: 'review-tools',
      name: 'Review Tools',
      version: '1.2.3',
      entry: 'dist/index.js',
      capabilities: ['tools'],
    })).toMatchObject({ id: 'review-tools', version: '1.2.3' });
    expect(() => parsePluginPackageManifest({
      schemaVersion: 1,
      id: 'bad',
      name: 'Bad',
      version: '1.0.0',
      entry: '../outside.js',
      capabilities: [],
    })).toThrow('stay inside');
  });
});
