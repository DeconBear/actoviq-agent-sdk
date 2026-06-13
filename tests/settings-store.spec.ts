import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistActoviqSettingsStore } from '../src/config/actoviqSettingsStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Actoviq settings store', () => {
  it('persists settings without changing their structure', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-settings-store-'));
    tempDirs.push(homeDir);
    const configPath = path.join(homeDir, '.actoviq', 'settings.json');

    await persistActoviqSettingsStore(configPath, {
      env: {
        ACTOVIQ_API_KEY: 'test-key',
        ACTOVIQ_PROVIDER: 'anthropic',
      },
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      env: {
        ACTOVIQ_API_KEY: 'test-key',
        ACTOVIQ_PROVIDER: 'anthropic',
      },
    });
    if (process.platform !== 'win32') {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });
});
