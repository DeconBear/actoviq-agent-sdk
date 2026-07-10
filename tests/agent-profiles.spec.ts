import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteAgentProfile,
  findAgentProfile,
  findSelectableAgent,
  getAgentProfilesPath,
  listAgentProfiles,
  listSelectableAgents,
  matchSelectableAgent,
  readAgentProfiles,
  resolveAgentProfileRun,
  resolveSelectableAgentRun,
  upsertAgentProfile,
} from '../src/config/agentProfiles.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('agentProfiles', () => {
  it('persists profiles against saved bridge configs', async () => {
    const home = await tempRoot('actoviq-agent-profiles-');
    addBridgeConfig({
      name: 'claude-main',
      runtime: 'claude',
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet',
      models: [{ name: 'claude-sonnet' }],
    }, home);

    const saved = upsertAgentProfile({
      name: 'reviewer',
      description: 'Reviews patches',
      bridgeConfig: 'claude-main',
      model: 'claude-sonnet',
      permissionMode: 'acceptEdits',
      effort: 'high',
      maxTokens: 16000,
      temperature: 0.2,
      systemPromptAppend: 'Focus on regressions.',
    }, home);

    expect(saved.warnings).toEqual([]);
    expect(findAgentProfile('reviewer', home)).toMatchObject({
      model: 'claude-sonnet',
      effort: 'high',
      maxTokens: 16000,
      temperature: 0.2,
    });
    expect(listAgentProfiles(home)).toHaveLength(1);
    await expect(readFile(getAgentProfilesPath(home), 'utf8')).resolves.toContain('reviewer');
  });

  it('rejects profiles whose bridge config is missing', async () => {
    const home = await tempRoot('actoviq-agent-profiles-missing-');

    expect(() => upsertAgentProfile({
      name: 'worker',
      bridgeConfig: 'missing',
      model: 'x',
    }, home)).toThrow('Bridge config not found');
  });

  it('warns but saves when a model is not registered on the bridge config', async () => {
    const home = await tempRoot('actoviq-agent-profiles-warn-');
    addBridgeConfig({
      name: 'openai-main',
      runtime: 'codex',
      provider: 'openai',
      apiKey: 'test-key',
      models: [{ name: 'gpt-4.1' }],
    }, home);

    const saved = upsertAgentProfile({
      name: 'custom',
      bridgeConfig: 'openai-main',
      model: 'gpt-custom',
    }, home);

    expect(saved.warnings[0]).toContain('not registered');
    expect(readAgentProfiles(home).profiles[0]?.model).toBe('gpt-custom');
  });

  it('resolves pure Hadamard profiles without building a separate model API', async () => {
    const home = await tempRoot('actoviq-agent-profiles-resolve-');
    addBridgeConfig({
      name: 'sdk-default',
      runtime: 'hadamard',
      provider: 'anthropic',
      model: 'claude-sonnet',
      models: [{ name: 'claude-sonnet' }],
    }, home);
    upsertAgentProfile({
      name: 'planner',
      bridgeConfig: 'sdk-default',
      model: 'claude-sonnet',
      permissionMode: 'plan',
    }, home);

    const resolved = await resolveAgentProfileRun('planner', home);

    expect(resolved.profile.name).toBe('planner');
    expect(resolved.model).toBe('claude-sonnet');
    expect(resolved.modelApi).toBeUndefined();
  });

  it('deletes profiles', async () => {
    const home = await tempRoot('actoviq-agent-profiles-delete-');
    addBridgeConfig({
      name: 'sdk-default',
      runtime: 'hadamard',
      provider: 'anthropic',
      model: 'claude-sonnet',
    }, home);
    upsertAgentProfile({ name: 'worker', bridgeConfig: 'sdk-default', model: 'claude-sonnet' }, home);

    const after = deleteAgentProfile('worker', home);

    expect(after.profiles).toEqual([]);
    expect(listAgentProfiles(home)).toEqual([]);
  });

  it('lists saved profiles plus auto presets from config models', async () => {
    const home = await tempRoot('actoviq-selectable-agents-');
    addBridgeConfig({
      name: 'deepseek',
      runtime: 'claude',
      provider: 'anthropic',
      apiKey: 'sk-x',
      model: 'deepseek-v4-pro',
      models: [{ name: 'deepseek-v4-pro' }, { name: 'deepseek-v4-flash' }],
    }, home);
    upsertAgentProfile({
      name: 'reviewer',
      bridgeConfig: 'deepseek',
      model: 'deepseek-v4-pro',
      effort: 'high',
      maxTokens: 8000,
      temperature: 0.3,
    }, home);

    const agents = listSelectableAgents(home);
    expect(agents.find(a => a.name === 'reviewer')).toMatchObject({
      source: 'profile',
      model: 'deepseek-v4-pro',
      effort: 'high',
      maxTokens: 8000,
      temperature: 0.3,
    });
    // Covered by reviewer — no duplicate auto preset for the same config+model.
    expect(agents.filter(a => a.bridgeConfig === 'deepseek' && a.model === 'deepseek-v4-pro')).toHaveLength(1);
    const flash = agents.find(a => a.model === 'deepseek-v4-flash');
    expect(flash).toMatchObject({
      source: 'config',
      ephemeral: true,
      bridgeConfig: 'deepseek',
    });
    expect(findSelectableAgent(flash!.name, home)?.model).toBe('deepseek-v4-flash');
    expect(matchSelectableAgent('deepseek', 'deepseek-v4-pro', home)?.name).toBe('reviewer');

    const resolved = await resolveSelectableAgentRun(flash!.name, home);
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.selectable.source).toBe('config');
  });
});
