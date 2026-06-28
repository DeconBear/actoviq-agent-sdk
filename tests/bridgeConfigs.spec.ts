import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addBridgeConfig,
  buildConfigEnv,
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
      { name: 'deepseek-claude', provider: 'claude', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
      { name: 'qwen', provider: 'pi', apiKey: 'sk-q' },
    ] }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(2);
    expect(read.configs[0]).toMatchObject({ name: 'deepseek-claude', provider: 'claude', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' });
    // optional fields absent when unset
    expect(read.configs[1]?.baseURL).toBeUndefined();
  });

  it('addBridgeConfig dedupes by name (replaces)', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'a', provider: 'claude', apiKey: 'old' }, home);
    addBridgeConfig({ name: 'a', provider: 'claude', apiKey: 'new', baseURL: 'https://x' }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(1);
    expect(read.configs[0]?.apiKey).toBe('new');
    expect(read.configs[0]?.baseURL).toBe('https://x');
  });

  it('removeBridgeConfig deletes by name', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'a', provider: 'claude' }, home);
    addBridgeConfig({ name: 'b', provider: 'pi' }, home);
    removeBridgeConfig('a', home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(1);
    expect(read.configs[0]?.name).toBe('b');
  });

  it('findBridgeConfig looks up by name', async () => {
    const home = await makeHome();
    addBridgeConfig({ name: 'deepseek-claude', provider: 'claude' }, home);
    expect(findBridgeConfig('deepseek-claude', home)?.provider).toBe('claude');
    expect(findBridgeConfig('missing', home)).toBeUndefined();
  });

  it('ignores malformed entries gracefully', async () => {
    const home = await makeHome();
    writeBridgeConfigs({ configs: [
      { name: 'ok', provider: 'claude' },
      { name: 'bad-provider', provider: 'nope' } as never,
      { provider: 'pi' } as never,
    ] }, home);
    const read = readBridgeConfigs(home);
    expect(read.configs).toHaveLength(1);
    expect(read.configs[0]?.name).toBe('ok');
  });

  it('getBridgeConfigsPath points under ~/.actoviq/bridge-configs.json', () => {
    expect(getBridgeConfigsPath('/home/user')).toBe(path.join('/home/user', '.actoviq', 'bridge-configs.json'));
  });
});

describe('buildConfigEnv', () => {
  it('maps claude credentials to ANTHROPIC_*', () => {
    const env = buildConfigEnv({ name: 'c', provider: 'claude', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-x');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-chat');
  });

  it('maps codex credentials to OPENAI_*', () => {
    const env = buildConfigEnv({ name: 'c', provider: 'codex', apiKey: 'sk-oai', baseURL: 'https://api.openai.com' });
    expect(env.OPENAI_API_KEY).toBe('sk-oai');
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com');
  });

  it('maps reasonix credentials to DEEPSEEK_API_KEY', () => {
    const env = buildConfigEnv({ name: 'c', provider: 'reasonix', apiKey: 'sk-ds' });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ds');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('maps pi to OPENAI_* by default, ANTHROPIC_* when baseURL mentions anthropic', () => {
    const oai = buildConfigEnv({ name: 'c', provider: 'pi', apiKey: 'k', baseURL: 'https://api.openai.com' });
    expect(oai.OPENAI_API_KEY).toBe('k');
    expect(oai.ANTHROPIC_API_KEY).toBeUndefined();
    const ant = buildConfigEnv({ name: 'c', provider: 'pi', apiKey: 'k', baseURL: 'https://api.anthropic.com' });
    expect(ant.ANTHROPIC_API_KEY).toBe('k');
    expect(ant.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('omits empty fields (never clobbers inherited values with nothing)', () => {
    const env = buildConfigEnv({ name: 'c', provider: 'claude' });
    expect(env).toEqual({});
  });

  it('maps codewhale to ANTHROPIC_* and crush to OPENAI_API_KEY', () => {
    expect(buildConfigEnv({ name: 'c', provider: 'codewhale', apiKey: 'k', baseURL: 'https://x' })).toMatchObject({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://x' });
    expect(buildConfigEnv({ name: 'c', provider: 'crush', apiKey: 'k' })).toMatchObject({ OPENAI_API_KEY: 'k' });
  });
});

describe('maskApiKey', () => {
  it('masks the middle of a long key', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1…cdef');
  });
  it('fully masks short keys', () => {
    expect(maskApiKey('short')).toBe('****');
  });
  it('reports none when absent', () => {
    expect(maskApiKey(undefined)).toBe('(none)');
  });
});
