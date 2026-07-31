import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistHadamardSettingsStore } from '../src/config/hadamardSettingsStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Hadamard settings store', () => {
  it('persists settings without changing their structure', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-settings-store-'));
    tempDirs.push(homeDir);
    const configPath = path.join(homeDir, '.hadamard', 'settings.json');

    await persistHadamardSettingsStore(configPath, {
      env: {
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_PROVIDER: 'anthropic',
      },
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      env: {
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_PROVIDER: 'anthropic',
      },
    });
    if (process.platform !== 'win32') {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });
});
