import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  encodeActoviqProjectPath,
  getActoviqProjectSessionDirectory,
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
            ACTOVIQ_DEFAULT_MEDIUM_MODEL: 'demo-model',
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
    expect(settings.env.ACTOVIQ_DEFAULT_MEDIUM_MODEL).toBe('demo-model');
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
            ACTOVIQ_DEFAULT_MEDIUM_MODEL: 'settings-model',
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
    expect(config.workDir).toBe(path.resolve('E:/demo'));
    expect(config.loadedConfigPath).toBe(settingsPath);
    expect(config.sessionDirectory).toBe(
      getActoviqProjectSessionDirectory('E:/demo', homeDir),
    );
  });

  it('uses a stable Claude-style project key for default session isolation', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'demo');
    const config = await resolveRuntimeConfig({
      homeDir,
      workDir,
      model: 'demo-model',
      authToken: 'test-token',
    });

    expect(config.sessionDirectory).toBe(
      path.join(homeDir, '.actoviq', 'projects', encodeActoviqProjectPath(workDir)),
    );
    // Encoding replaces all non-alphanumeric characters with hyphens.
    // On Windows, drive letters produce patterns like E--repo-demo.
    // On Unix, absolute paths produce patterns like -home-repo-demo.
    const samplePath = process.platform === 'win32' ? 'E:\\repo\\demo' : '/home/repo/demo';
    const sampleExpected = process.platform === 'win32' ? 'E--repo-demo' : '-home-repo-demo';
    expect(encodeActoviqProjectPath(samplePath)).toBe(sampleExpected);
  });

  it('migrates only matching legacy project sessions into the project store', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace');
    const legacySessions = path.join(
      homeDir,
      '.actoviq',
      'actoviq-agent-sdk',
      'sessions',
    );
    await mkdir(legacySessions, { recursive: true });
    await writeFile(
      path.join(legacySessions, 'matching.json'),
      JSON.stringify({ id: 'matching', metadata: { __actoviqWorkDir: workDir } }),
    );
    await writeFile(
      path.join(legacySessions, 'other.json'),
      JSON.stringify({
        id: 'other',
        metadata: { __actoviqWorkDir: path.join(homeDir, 'other') },
      }),
    );

    const config = await resolveRuntimeConfig({
      homeDir,
      workDir,
      model: 'demo-model',
      authToken: 'test-token',
    });

    expect(
      JSON.parse(
        await readFile(path.join(config.sessionDirectory, 'sessions', 'matching.json'), 'utf8'),
      ),
    ).toMatchObject({ id: 'matching' });
    await expect(
      readFile(path.join(config.sessionDirectory, 'sessions', 'other.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves and validates the default reasoning effort', async () => {
    const homeDir = await createTempHome();
    const config = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
      effort: 'high',
    });
    expect(config.effort).toBe('high');

    await expect(
      resolveRuntimeConfig({
        homeDir,
        model: 'demo-model',
        authToken: 'test-token',
        effort: 'invalid' as never,
      }),
    ).rejects.toThrow('Invalid effort');
  });

  it('resolves neutral model tiers and defaults to medium', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'tier-config.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ACTOVIQ_AUTH_TOKEN: 'settings-token',
          ACTOVIQ_DEFAULT_MIN_MODEL: 'small-model',
          ACTOVIQ_DEFAULT_MEDIUM_MODEL: 'balanced-model',
          ACTOVIQ_DEFAULT_MAX_MODEL: 'large-model',
        },
      }),
      'utf8',
    );
    await loadJsonConfigFile(settingsPath);

    const defaulted = await resolveRuntimeConfig({ homeDir });
    const explicitTier = await resolveRuntimeConfig({ homeDir, model: 'max' });

    expect(defaulted.model).toBe('balanced-model');
    expect(defaulted.modelTier).toBe('medium');
    expect(explicitTier.model).toBe('large-model');
    expect(explicitTier.modelTier).toBe('max');
    expect(defaulted.modelTiers).toEqual({
      min: 'small-model',
      medium: 'balanced-model',
      max: 'large-model',
    });
  });

  it('defaults maxToolIterations to unlimited and honors an explicit cap', async () => {
    const homeDir = await createTempHome();

    const defaulted = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
    });
    expect(defaulted.maxToolIterations).toBe(Number.POSITIVE_INFINITY);

    const capped = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
      maxToolIterations: 24,
    });
    expect(capped.maxToolIterations).toBe(24);
  });

  it('requires an explicit or tiered model for the anthropic protocol', async () => {
    const homeDir = await createTempHome();

    await expect(
      resolveRuntimeConfig({
        homeDir,
        authToken: 'test-token',
      }),
    ).rejects.toThrow('No model was configured');
  });

  it('resolves runtime config from process environment variables', async () => {
    const homeDir = await createTempHome();
    const previous = {
      token: process.env.ACTOVIQ_AUTH_TOKEN,
      provider: process.env.ACTOVIQ_PROVIDER,
      model: process.env.ACTOVIQ_MODEL,
      baseURL: process.env.ACTOVIQ_BASE_URL,
    };

    process.env.ACTOVIQ_AUTH_TOKEN = 'env-token';
    process.env.ACTOVIQ_PROVIDER = 'openai';
    process.env.ACTOVIQ_MODEL = 'env-model';
    process.env.ACTOVIQ_BASE_URL = 'https://example.test/env';

    try {
      const config = await resolveRuntimeConfig({ homeDir });

      expect(config.authToken).toBe('env-token');
      expect(config.provider).toBe('openai');
      expect(config.model).toBe('env-model');
      expect(config.baseURL).toBe('https://example.test/env');
    } finally {
      if (previous.token === undefined) delete process.env.ACTOVIQ_AUTH_TOKEN;
      else process.env.ACTOVIQ_AUTH_TOKEN = previous.token;
      if (previous.provider === undefined) delete process.env.ACTOVIQ_PROVIDER;
      else process.env.ACTOVIQ_PROVIDER = previous.provider;
      if (previous.model === undefined) delete process.env.ACTOVIQ_MODEL;
      else process.env.ACTOVIQ_MODEL = previous.model;
      if (previous.baseURL === undefined) delete process.env.ACTOVIQ_BASE_URL;
      else process.env.ACTOVIQ_BASE_URL = previous.baseURL;
    }
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
