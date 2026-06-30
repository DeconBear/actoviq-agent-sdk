import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverAgentRuntimes } from '../src/runtime/agentRuntimeDiscovery.js';
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
