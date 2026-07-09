import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
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

async function api<T>(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI agent profile API', () => {
  it('creates, lists, and deletes agent profiles', async () => {
    const root = await tempRoot('actoviq-gui-agent-profiles-');
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

    const server = await startActoviqGuiServer({
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
        }),
      });
      expect(created.status).toBe(200);
      expect(created.body.ok).toBe(true);
      expect(created.body.warnings).toEqual([]);
      expect(created.body.state.agentProfiles[0]).toMatchObject({
        name: 'reviewer',
        bridgeConfig: 'sdk-default',
        model: 'claude-sonnet',
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
});
