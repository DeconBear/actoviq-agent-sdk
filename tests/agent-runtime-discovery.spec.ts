import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  detectRuntimeLocalConfig,
  discoverAgentRuntimes,
  updateRuntimeLocalConfig,
} from '../src/runtime/agentRuntimeDiscovery.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'runtime-discovery-home-'));
  tempHomes.push(home);
  return home;
}

describe('discoverAgentRuntimes', () => {
  it('reports built-in, detected, configured, ready, and missing runtimes', async () => {
    const homeDir = await makeHome();
    addBridgeConfig({ name: 'claude-local', runtime: 'claude', provider: 'anthropic' }, homeDir);
    addBridgeConfig({ name: 'codex-config', runtime: 'codex', provider: 'openai' }, homeDir);

    const foundCommands = new Map([
      ['claude', '/usr/local/bin/claude'],
      ['pi-agent', '/usr/local/bin/pi-agent'],
    ]);
    const results = await discoverAgentRuntimes({
      homeDir,
      candidates: [
        { id: 'hadamard', label: 'Hadamard SDK', runtime: 'hadamard', commands: [], description: 'built in' },
        { id: 'claude-code', label: 'Claude Code', runtime: 'claude', commands: ['claude'], versionArgs: ['--version'], description: 'claude' },
        { id: 'pi-agent', label: 'Pi Agent', runtime: 'pi', commands: ['pi-agent'], versionArgs: ['--version'], description: 'pi' },
        { id: 'codex', label: 'Codex CLI', runtime: 'codex', commands: ['codex'], versionArgs: ['--version'], description: 'codex' },
        { id: 'crush', label: 'Crush', runtime: 'crush', commands: ['crush'], description: 'crush' },
      ],
      resolveCommand: async (command) => foundCommands.get(command),
      readVersion: async (commandPath) => `${path.basename(commandPath)} 1.2.3\n`,
    });

    const byId = Object.fromEntries(results.map(item => [item.id, item]));

    expect(byId.hadamard).toMatchObject({
      status: 'ready',
      installed: true,
      configured: true,
      provider: null,
    });
    expect(byId['claude-code']).toMatchObject({
      status: 'ready',
      installed: true,
      configured: true,
      command: 'claude',
      commandPath: '/usr/local/bin/claude',
      version: 'claude 1.2.3',
      configNames: ['claude-local'],
    });
    expect(byId['pi-agent']).toMatchObject({
      status: 'detected',
      installed: true,
      configured: false,
      provider: 'openai',
    });
    expect(byId.codex).toMatchObject({
      status: 'configured',
      installed: false,
      configured: true,
      configNames: ['codex-config'],
    });
    expect(byId.crush).toMatchObject({
      status: 'missing',
      installed: false,
      configured: false,
    });
  });
});

describe('runtime local config', () => {
  it('detects and updates Claude-style local config', async () => {
    const homeDir = await makeHome();
    const settingsDir = path.join(homeDir, '.claude');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_MODEL: 'glm-5.2',
          ANTHROPIC_BASE_URL: 'https://example.com',
          ANTHROPIC_AUTH_TOKEN: 'secret-key',
        },
      }),
      'utf-8',
    );

    expect(detectRuntimeLocalConfig('claude', homeDir)).toMatchObject({
      runtime: 'claude',
      model: 'glm-5.2',
      baseURL: 'https://example.com',
      apiKey: 'secret-key',
      provider: 'anthropic',
      source: '~/.claude/settings.json',
    });

    const result = updateRuntimeLocalConfig('claude', {
      model: 'glm-5.2[1M]',
      baseURL: 'https://ark.example.com/api',
      apiKey: 'new-secret',
    }, homeDir);
    expect(result).toEqual({ ok: true, source: '~/.claude/settings.json' });

    const saved = JSON.parse(readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
    expect(saved.env).toMatchObject({
      ANTHROPIC_MODEL: 'glm-5.2[1M]',
      ANTHROPIC_BASE_URL: 'https://ark.example.com/api',
      ANTHROPIC_AUTH_TOKEN: 'new-secret',
    });
    expect(saved.model).toBe('glm-5.2[1M]');
  });

  it('detects and updates Codex local config', async () => {
    const homeDir = await makeHome();
    const codexDir = path.join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-4"\n', 'utf-8');

    expect(detectRuntimeLocalConfig('codex', homeDir)).toMatchObject({
      runtime: 'codex',
      model: 'gpt-4',
      provider: 'openai',
    });

    const result = updateRuntimeLocalConfig('codex', { model: 'gpt-5' }, homeDir);
    expect(result).toEqual({ ok: true, source: '~/.codex/config.toml' });
    expect(readFileSync(path.join(codexDir, 'config.toml'), 'utf-8')).toContain('model = "gpt-5"');
  });
});
