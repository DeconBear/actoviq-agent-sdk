import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { addBridgeConfig, readBridgeConfigs } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function api<T>(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-hadamard-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI agent profile API', () => {
  it('creates, lists, and deletes agent profiles', async () => {
    const root = await tempRoot('hadamard-gui-agent-profiles-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });
    addBridgeConfig({
      name: 'sdk-default',
      runtime: 'hadamard',
      provider: 'anthropic',
      model: 'claude-sonnet',
      models: [{ name: 'claude-sonnet' }],
    }, homeDir);

    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const created = await api<{
        ok: boolean;
        warnings: string[];
        state: { agentProfiles: Array<{ name: string; model: string; bridgeConfig: string }> };
      }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'reviewer',
          bridgeConfig: 'sdk-default',
          model: 'claude-sonnet',
          permissionMode: 'acceptEdits',
          effort: 'max',
          maxTokens: 12000,
          temperature: 0.4,
          topP: 0.75,
        }),
      });
      expect(created.status).toBe(200);
      expect(created.body.ok).toBe(true);
      expect(created.body.warnings).toEqual([]);
      expect(created.body.state.agentProfiles[0]).toMatchObject({
        name: 'reviewer',
        bridgeConfig: 'sdk-default',
        model: 'claude-sonnet',
        effort: 'max',
        maxTokens: 12000,
        temperature: 0.4,
        topP: 0.75,
      });

      const listed = await api<{ profiles: Array<{ name: string }> }>(server, 'api/agent-profiles');
      expect(listed.status).toBe(200);
      expect(listed.body.profiles.map(profile => profile.name)).toEqual(['reviewer']);

      const rejected = await api<{ error: string }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bad', bridgeConfig: 'missing', model: 'x' }),
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('Bridge config not found');

      const deleted = await api<{ agentProfiles: unknown[] }>(server, 'api/agent-profiles/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reviewer' }),
      });
      expect(deleted.status).toBe(200);
      expect(deleted.body.agentProfiles).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('exposes selectable agents and activates by agent name', async () => {
    const root = await tempRoot('hadamard-gui-agent-activate-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });
    addBridgeConfig({
      name: 'deepseek',
      runtime: 'hadamard',
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      models: [{ name: 'deepseek-v4-pro' }, { name: 'deepseek-v4-flash' }],
    }, homeDir);

    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const state = await api<{
        selectableAgents: Array<{ name: string; model: string; source: string }>;
        activeAgent: { name: string } | null;
      }>(server, 'api/state');
      expect(state.status).toBe(200);
      expect(state.body.selectableAgents.length).toBeGreaterThanOrEqual(2);
      expect(state.body.activeAgent).toBeNull();

      const flash = state.body.selectableAgents.find(a => a.model === 'deepseek-v4-flash');
      expect(flash).toBeTruthy();

      const activated = await api<{
        activeAgent: { name: string; model: string };
        bridgeState: { activeConfig: { name: string; model: string } | null };
      }>(server, 'api/agent/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: flash!.name }),
      });
      expect(activated.status).toBe(200);
      expect(activated.body.activeAgent).toMatchObject({
        name: flash!.name,
        model: 'deepseek-v4-flash',
      });
      expect(activated.body.bridgeState.activeConfig).toMatchObject({
        name: 'deepseek',
        model: 'deepseek-v4-flash',
      });
      expect(readBridgeConfigs(homeDir).configs.find(config => config.name === 'deepseek')?.model)
        .toBe('deepseek-v4-pro');
    } finally {
      await server.close();
    }
  });

  it('keeps runtime and model selection scoped to the active chat', async () => {
    const root = await tempRoot('hadamard-gui-agent-session-scope-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const configPath = path.join(homeDir, 'settings.json');
    await mkdir(workDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1',
        HADAMARD_MODEL: 'model-default',
      },
    }), 'utf8');
    addBridgeConfig({
      name: 'codex-runtime',
      runtime: 'codex',
      provider: 'openai',
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:1/v1',
      model: 'model-alpha',
      models: [{ name: 'model-alpha' }, { name: 'model-alpha-v2' }],
    }, homeDir);

    let server = await startHadamardGuiServer({
      workDir,
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      type SelectionState = {
        session: { id: string };
        selectableAgents: Array<{ name: string; bridgeConfig: string; model: string }>;
        activeAgent: { name: string; bridgeConfig: string; model: string } | null;
        bridgeState: { activeConfig: { name: string; runtime: string; model: string } | null };
      };
      const initial = await api<SelectionState>(server, 'api/state');
      const alpha = initial.body.selectableAgents.find(agent =>
        agent.bridgeConfig === 'codex-runtime' && agent.model === 'model-alpha');
      const beta = initial.body.selectableAgents.find(agent =>
        agent.bridgeConfig === 'codex-runtime' && agent.model === 'model-alpha-v2');
      expect(alpha).toBeTruthy();
      expect(beta).toBeTruthy();

      const alphaActivated = await api<SelectionState>(server, 'api/agent/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: alpha!.name }),
      });
      expect(alphaActivated.body.activeAgent).toMatchObject({
        bridgeConfig: 'codex-runtime',
        model: 'model-alpha',
      });
      expect(alphaActivated.body.bridgeState.activeConfig?.runtime).toBe('codex');

      addBridgeConfig({
        name: 'codex-runtime',
        runtime: 'codex',
        provider: 'openai',
        apiKey: 'test-key',
        baseURL: 'http://127.0.0.1:1/v1',
        model: 'model-alpha-v2',
        models: [{ name: 'model-alpha' }, { name: 'model-alpha-v2' }],
      }, homeDir);
      await server.close();
      server = await startHadamardGuiServer({
        workDir,
        homeDir,
        configPath,
        resumeSessionId: initial.body.session.id,
        host: '127.0.0.1',
        port: 45000 + Math.floor(Math.random() * 10000),
      });
      const resumed = await api<SelectionState>(server, 'api/state');
      expect(resumed.body.activeAgent).toMatchObject({
        bridgeConfig: 'codex-runtime',
        model: 'model-alpha',
      });
      expect(resumed.body.bridgeState.activeConfig).toMatchObject({
        name: 'codex-runtime',
        runtime: 'codex',
        model: 'model-alpha',
      });

      const fresh = await api<SelectionState>(server, 'api/session/new', { method: 'POST' });
      expect(fresh.body.session.id).not.toBe(initial.body.session.id);
      expect(fresh.body.activeAgent).toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);
});
