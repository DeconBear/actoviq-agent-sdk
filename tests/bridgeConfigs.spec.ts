import { mkdtemp, rm } from 'node:fs/promises';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addBridgeConfig,
  buildConfigEnv,
  findBridgeConfig,
  getBridgeConfigsPath,
  isManagedExternalCliRuntime,
  MANAGED_EXTERNAL_CLI_RUNTIMES,
  maskApiKey,
  readBridgeConfigs,
  removeBridgeConfig,
  runtimeToProvider,
  VALID_RUNTIMES,
  writeBridgeConfigs,
} from '../src/parity/bridgeConfigs.js';

const tempHomes: string[] = [];

const managedRuntimeProviderCases = [
  ['claude', 'anthropic'],
  ['codex', 'openai'],
  ['pi', 'openai'],
  ['codewhale', 'anthropic'],
  ['reasonix', 'openai'],
  ['crush', 'openai'],
] as const;

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(h => rm(h, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const h = await mkdtemp(path.join(os.tmpdir(), 'bridgecfg-home-'));
  tempHomes.push(h);
  return h;
}

describe('bridgeConfigs persistence', () => {
  it('reads empty when no file exists', async () => {
    const home = await makeHome();
    expect(readBridgeConfigs(home)).toEqual({ configs: [] });
  });

  it('writes then reads a config round-trip', async () => {
    const home = await makeHome();
    writeBridgeConfigs({ configs: [
      { name: 'deepseek', runtime: 'claude', provider: 'anthropic' as const, apiKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
      { name: 'qwen', runtime: 'claude', provider: 'openai' as const, apiKey: 'sk-q' },
    ] }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(2);
    expect(read.configs[0]).toMatchObject({ name: 'deepseek', provider: 'anthropic', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' });
    expect(read.configs[1]?.baseURL).toBeUndefined();
    expect(read.configs[0]).toMatchObject({ execution: 'api', authSource: 'apiKey' });
  });

  it.runIf(process.platform !== 'win32')('creates config storage with private POSIX permissions', async () => {
    const home = await makeHome();
    const file = getBridgeConfigsPath(home);

    writeBridgeConfigs({ configs: [
      { name: 'private', runtime: 'claude', provider: 'anthropic', apiKey: 'sk-secret' },
    ] }, home);

    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('hardens permissions on existing config storage when reading', async () => {
    const home = await makeHome();
    const file = getBridgeConfigsPath(home);
    const directory = path.dirname(file);
    const contents = `${JSON.stringify({ configs: [{
      name: 'existing',
      provider: 'anthropic',
      runtime: 'claude',
      execution: 'api',
      authSource: 'apiKey',
    }] }, null, 2)}\n`;
    mkdirSync(directory, { recursive: true, mode: 0o777 });
    writeFileSync(file, contents, { encoding: 'utf-8', mode: 0o666 });
    chmodSync(directory, 0o777);
    chmodSync(file, 0o666);

    expect(readBridgeConfigs(home).configs).toHaveLength(1);
    expect(readFileSync(file, 'utf-8')).toBe(contents);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each(managedRuntimeProviderCases)(
    'persists %s CLI execution and native authentication separately',
    async (runtime, provider) => {
    const home = await makeHome();
    addBridgeConfig({
      name: `local-${runtime}`,
      runtime,
      provider,
      execution: 'cli',
      authSource: 'native',
    }, home);

    expect(findBridgeConfig(`local-${runtime}`, home)).toMatchObject({
      runtime,
      provider,
      execution: 'cli',
      authSource: 'native',
    });
    },
  );

  it('addBridgeConfig dedupes by name (replaces)', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'a', runtime: 'claude', provider: 'anthropic', apiKey: 'old' }, home);
    addBridgeConfig({ name: 'a', runtime: 'claude', provider: 'anthropic', apiKey: 'new', baseURL: 'https://x' }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(1);
    expect(read.configs[0]?.apiKey).toBe('new');
    expect(read.configs[0]?.baseURL).toBe('https://x');
  });

  it('removeBridgeConfig deletes by name', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'a', runtime: 'claude', provider: 'anthropic' }, home);
    addBridgeConfig({ name: 'b', runtime: 'claude', provider: 'openai' }, home);
    removeBridgeConfig('a', home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(1);
    expect(read.configs[0]?.name).toBe('b');
  });

  it('findBridgeConfig looks up by name', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'deepseek', runtime: 'claude', provider: 'anthropic' }, home);
    expect(findBridgeConfig('deepseek', home)?.provider).toBe('anthropic');
    expect(findBridgeConfig('missing', home)).toBeUndefined();
  });

  it('migrates unknown providers to anthropic and drops entries without a name', async () => {
    const home = await makeHome();
    writeBridgeConfigs({ configs: [
      { name: 'ok', runtime: 'claude', provider: 'anthropic' },
      { name: 'migrated', runtime: 'claude', provider: 'nope' } as never,
      { provider: 'openai', runtime: 'claude' } as never,
    ] }, home);
    const read = readBridgeConfigs(home);
    // 'ok' + 'migrated' (nope→anthropic) both survive; nameless entry dropped.
    expect(read.configs).toHaveLength(2);
    expect(read.configs.find(c => c.name === 'migrated')?.provider).toBe('anthropic');
  });

  it('getBridgeConfigsPath points under ~/.hadamard/bridge-configs.json', () => {
    expect(getBridgeConfigsPath('/home/user')).toBe(path.join('/home/user', '.hadamard', 'bridge-configs.json'));
  });
});

describe('managed External CLI runtime gates', () => {
  it('exports the complete six-runtime registry and wire-protocol mapping', () => {
    expect(MANAGED_EXTERNAL_CLI_RUNTIMES).toEqual([
      'claude',
      'codewhale',
      'pi',
      'codex',
      'reasonix',
      'crush',
    ]);
    expect(VALID_RUNTIMES).toEqual([
      'hadamard',
      'claude',
      'codewhale',
      'pi',
      'codex',
      'reasonix',
      'crush',
    ]);
    for (const [runtime, provider] of managedRuntimeProviderCases) {
      expect(isManagedExternalCliRuntime(runtime)).toBe(true);
      expect(runtimeToProvider(runtime)).toBe(provider);
    }
    expect(isManagedExternalCliRuntime('hadamard')).toBe(false);
    expect(runtimeToProvider('hadamard')).toBeNull();
  });
});

describe('legacy provider migration', () => {
  it('migrates legacy RuntimeProviderId → in-process provider on read', async () => {
    // Must use an isolated temp home — never os.tmpdir()/.hadamard, which is shared.
    const home = await makeHome();
    const file = getBridgeConfigsPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ configs: [
      { name: 'legacy-claude', provider: 'claude', apiKey: 'sk-c', baseURL: 'https://x.com' },
      { name: 'legacy-pi', provider: 'pi', apiKey: 'sk-pi' },
      { name: 'legacy-codex', provider: 'codex' },
      { name: 'legacy-codewhale', provider: 'codewhale' },
      { name: 'legacy-reasonix', provider: 'reasonix' },
      { name: 'legacy-crush', provider: 'crush' },
    ] }));

    const read = readBridgeConfigs(home);

    const byName: Record<string, string> = {};
    for (const c of read.configs) byName[c.name] = c.provider;

    expect(byName['legacy-claude']).toBe('anthropic');
    expect(byName['legacy-pi']).toBe('openai');
    expect(byName['legacy-codex']).toBe('openai');
    expect(byName['legacy-codewhale']).toBe('anthropic');
    expect(byName['legacy-reasonix']).toBe('openai');
    expect(byName['legacy-crush']).toBe('openai');
    // Migrated file is re-saved only when contents change.
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as { configs: Array<{ provider: string }> };
    expect(saved.configs.every((c) => c.provider === 'anthropic' || c.provider === 'openai')).toBe(true);
  });

  it('leaves already-correct anthropic/openai untouched', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'a', runtime: 'claude', provider: 'anthropic' }, home);
    addBridgeConfig({ name: 'b', runtime: 'claude', provider: 'openai' }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs[0]?.provider).toBe('anthropic');
    expect(read.configs[1]?.provider).toBe('openai');
  });
});

describe('maskApiKey', () => {
  it('masks the middle of a long key', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1...cdef');
  });
  it('fully masks short keys', () => {
    expect(maskApiKey('short')).toBe('****');
  });
  it('reports none when absent', () => {
    expect(maskApiKey(undefined)).toBe('(none)');
  });
});

describe('buildConfigEnv', () => {
  it.each(managedRuntimeProviderCases)(
    'does not override a native %s CLI login',
    (runtime, provider) => {
    expect(buildConfigEnv({
      name: 'native',
      runtime,
      provider,
      execution: 'cli',
      authSource: 'native',
      apiKey: 'must-not-leak',
    })).toEqual({});
    },
  );

  it('maps an explicit Claude CLI API-key override to child-only environment variables', () => {
    expect(buildConfigEnv({
      name: 'override',
      runtime: 'claude',
      provider: 'anthropic',
      execution: 'cli',
      authSource: 'apiKey',
      apiKey: 'sk-test',
      baseURL: 'https://example.test',
      model: 'claude-test',
    })).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://example.test',
      ANTHROPIC_MODEL: 'claude-test',
    });
  });

  it('maps a Codex CLI API-key override without touching native config files', () => {
    expect(buildConfigEnv({
      name: 'override',
      runtime: 'codex',
      provider: 'openai',
      execution: 'cli',
      authSource: 'apiKey',
      apiKey: 'sk-test',
      baseURL: 'https://example.test/v1',
    })).toEqual({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://example.test/v1',
    });
  });

  it.each([
    ['codewhale', 'anthropic', 'DEEPSEEK_API_KEY'],
    ['pi', 'openai', 'OPENAI_API_KEY'],
    ['reasonix', 'openai', 'DEEPSEEK_API_KEY'],
    ['crush', 'openai', 'CRUSH_OPENAI_API_KEY'],
  ] as const)(
    'maps a %s CLI API-key override to its child-only credential variable',
    (runtime, provider, credentialVariable) => {
      expect(buildConfigEnv({
        name: `${runtime}-override`,
        runtime,
        provider,
        execution: 'cli',
        authSource: 'apiKey',
        apiKey: 'sk-test',
      })).toEqual({ [credentialVariable]: 'sk-test' });
    },
  );
});
