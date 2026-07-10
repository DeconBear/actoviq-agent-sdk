import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
  const url = new URL(requestPath.replace(/^\/+/, ''), server.url);
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI runtime local config reuse', () => {
  it('reads and updates external runtime config from the user home, not the Actoviq data root', async () => {
    const root = await tempRoot('actoviq-gui-runtime-home-');
    const userHome = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const dataRoot = path.join(userHome, '.actoviq');
    const claudeDir = path.join(userHome, '.claude');
    const migratedDataRoot = path.join(root, 'actoviq-data');
    await mkdir(workDir, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');
    await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_MODEL: 'claude-local-model',
        ANTHROPIC_BASE_URL: 'https://claude.local',
        ANTHROPIC_AUTH_TOKEN: 'local-secret',
      },
    }), 'utf8');

    const port = 45000 + Math.floor(Math.random() * 10000);
    const server = await startActoviqGuiServer({
      workDir,
      homeDir: userHome,
      host: '127.0.0.1',
      port,
    });

    try {
      const before = await api<{
        model?: string;
        baseURL?: string;
        apiKey?: string;
        source?: string;
      }>(server, '/api/bridge/detect-local?runtime=claude');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        model: 'claude-local-model',
        baseURL: 'https://claude.local',
        apiKey: 'local-secret',
        source: '~/.claude/settings.json',
      });

      const stateBefore = await api<{
        bridgeState: {
          runtimeDiscovery: Array<{ runtime: string; localConfig: null | { model: string; baseURL: string; hasApiKey: boolean } }>;
        };
      }>(server, '/api/state');
      expect(stateBefore.status).toBe(200);
      expect(stateBefore.body.bridgeState.runtimeDiscovery.find((item) => item.runtime === 'claude')?.localConfig)
        .toMatchObject({
          model: 'claude-local-model',
          baseURL: 'https://claude.local',
          hasApiKey: true,
        });

      const migrated = await api<{ ok: boolean; dataRoot: { root: string } }>(server, '/api/settings/data-root', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetRoot: migratedDataRoot, confirmed: true }),
      });
      expect(migrated.status).toBe(200);
      expect(migrated.body.dataRoot.root).toBe(path.resolve(migratedDataRoot));

      const afterMigration = await api<{ model?: string; baseURL?: string; apiKey?: string }>(
        server,
        '/api/bridge/detect-local?runtime=claude',
      );
      expect(afterMigration.status).toBe(200);
      expect(afterMigration.body).toMatchObject({
        model: 'claude-local-model',
        baseURL: 'https://claude.local',
        apiKey: 'local-secret',
      });

      const updated = await api<{ ok: boolean; source: string }>(server, '/api/bridge/update-local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtime: 'claude',
          model: 'claude-updated-model',
          baseURL: 'https://updated.local',
          apiKey: 'updated-secret',
        }),
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ ok: true, source: '~/.claude/settings.json' });

      const saved = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
      expect(saved.env).toMatchObject({
        ANTHROPIC_MODEL: 'claude-updated-model',
        ANTHROPIC_BASE_URL: 'https://updated.local',
        ANTHROPIC_AUTH_TOKEN: 'updated-secret',
      });
      await expect(access(path.join(migratedDataRoot, '.claude', 'settings.json'))).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
