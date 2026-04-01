import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
  resolveRuntimeConfig,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  clearLoadedJsonConfig();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-config-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('config loading', () => {
  it('loads a preselected JSON config file from an arbitrary path', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'my-agent-config.json');

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            ACTOVIQ_AUTH_TOKEN: 'test-token',
            ACTOVIQ_BASE_URL: 'https://example.test/actoviq',
            ACTOVIQ_DEFAULT_SONNET_MODEL: 'demo-model',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const settings = await loadJsonConfigFile(settingsPath);

    expect(settings.exists).toBe(true);
    expect(settings.env.ACTOVIQ_AUTH_TOKEN).toBe('test-token');
    expect(settings.env.ACTOVIQ_DEFAULT_SONNET_MODEL).toBe('demo-model');
    expect(settings.path).toBe(settingsPath);
  });

  it('resolves runtime config from explicit options and the preloaded JSON config', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'custom-runtime-config.json');

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            ACTOVIQ_AUTH_TOKEN: 'settings-token',
            ACTOVIQ_BASE_URL: 'https://example.test/actoviq',
            ACTOVIQ_DEFAULT_SONNET_MODEL: 'settings-model',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await loadJsonConfigFile(settingsPath);

    const config = await resolveRuntimeConfig({
      homeDir,
      model: 'explicit-model',
      workDir: 'E:/demo',
    });

    expect(config.authToken).toBe('settings-token');
    expect(config.baseURL).toBe('https://example.test/actoviq');
    expect(config.model).toBe('explicit-model');
    expect(config.workDir).toBe('E:/demo');
    expect(config.loadedConfigPath).toBe(settingsPath);
    expect(config.sessionDirectory).toContain('.actoviq');
  });

  it('loads the default Actoviq settings from ~/.actoviq/settings.json only', async () => {
    const homeDir = await createTempHome();
    const actoviqDir = path.join(homeDir, '.actoviq');
    const settingsPath = path.join(actoviqDir, 'settings.json');

    await mkdir(actoviqDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            ACTOVIQ_AUTH_TOKEN: 'bridge-token',
            ACTOVIQ_BASE_URL: 'https://example.test/runtime',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const settings = await loadDefaultActoviqSettings({ homeDir });

    expect(settings.path).toBe(settingsPath);
    expect(settings.env.ACTOVIQ_AUTH_TOKEN).toBe('bridge-token');
  });
});
