import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addBridgeConfig,
  findBridgeConfig,
  getBridgeConfigsPath,
  maskApiKey,
  readBridgeConfigs,
  removeBridgeConfig,
  writeBridgeConfigs,
} from '../src/parity/bridgeConfigs.js';

const tempHomes: string[] = [];

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
  });

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

  it('getBridgeConfigsPath points under ~/.actoviq/bridge-configs.json', () => {
    expect(getBridgeConfigsPath('/home/user')).toBe(path.join('/home/user', '.actoviq', 'bridge-configs.json'));
  });
});

describe('legacy provider migration', () => {
  const HOME = os.tmpdir();

  it('migrates legacy RuntimeProviderId → in-process provider on read', () => {
    const file = getBridgeConfigsPath(HOME);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ configs: [
      { name: 'legacy-claude', provider: 'claude', apiKey: 'sk-c', baseURL: 'https://x.com' },
      { name: 'legacy-pi', provider: 'pi', apiKey: 'sk-pi' },
      { name: 'legacy-codex', provider: 'codex' },
      { name: 'legacy-codewhale', provider: 'codewhale' },
      { name: 'legacy-reasonix', provider: 'reasonix' },
      { name: 'legacy-crush', provider: 'crush' },
    ] }));

    const read = readBridgeConfigs(HOME);

    const byName: Record<string, string> = {};
    for (const c of read.configs) byName[c.name] = c.provider;

    expect(byName['legacy-claude']).toBe('anthropic');
    expect(byName['legacy-pi']).toBe('openai');
    expect(byName['legacy-codex']).toBe('openai');
    expect(byName['legacy-codewhale']).toBe('anthropic');
    expect(byName['legacy-reasonix']).toBe('openai');
    expect(byName['legacy-crush']).toBe('openai');
    // Migrated file is re-saved (best-effort).
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
