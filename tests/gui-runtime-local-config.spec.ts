import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

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
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const url = new URL(requestPath.replace(/^\/+/, ''), server.url);
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-hadamard-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI runtime local config reuse', () => {
  it('reads and updates external runtime config from the user home, not the Hadamard data root', async () => {
    const root = await tempRoot('hadamard-gui-runtime-home-');
    const userHome = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const dataRoot = path.join(userHome, '.hadamard');
    const claudeDir = path.join(userHome, '.claude');
    const migratedDataRoot = path.join(root, 'hadamard-data');
    await mkdir(workDir, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');
    await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_MODEL: 'claude-local-model',
        ANTHROPIC_BASE_URL: 'https://claude.local',
        ANTHROPIC_AUTH_TOKEN: 'local-secret',
      },
    }), 'utf8');

    const port = 45000 + Math.floor(Math.random() * 10000);
    const server = await startHadamardGuiServer({
      workDir,
      homeDir: userHome,
      host: '127.0.0.1',
      port,
    });

    try {
      const before = await api<{
        model?: string;
        baseURL?: string;
        hasApiKey?: boolean;
        apiKey?: string;
        source?: string;
      }>(server, '/api/bridge/detect-local?runtime=claude');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        model: 'claude-local-model',
        baseURL: 'https://claude.local',
        hasApiKey: true,
        apiKey: 'local-secret',
        source: '~/.claude/settings.json',
      });

      const stateBefore = await api<{
        settings: { apiKey: string };
        bridgeState: {
          runtimeDiscovery: Array<{ runtime: string; localConfig: null | { model: string; baseURL: string; hasApiKey: boolean } }>;
        };
      }>(server, '/api/state');
      expect(stateBefore.status).toBe(200);
      expect(stateBefore.body.settings.apiKey).toBe('test-key');
      expect(stateBefore.body.bridgeState.runtimeDiscovery.find((item) => item.runtime === 'claude')?.localConfig)
        .toMatchObject({
          model: 'claude-local-model',
          baseURL: 'https://claude.local',
          hasApiKey: true,
        });

      const clearedDefaultKey = await api<{ settings: { apiKey: string; apiKeyConfigured: boolean } }>(
        server,
        '/api/settings',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'test-key', clearApiKey: true }),
        },
      );
      expect(clearedDefaultKey.status).toBe(200);
      expect(clearedDefaultKey.body.settings).toMatchObject({ apiKey: '', apiKeyConfigured: false });

      const migrated = await api<{ ok: boolean; dataRoot: { root: string } }>(server, '/api/settings/data-root', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetRoot: migratedDataRoot, confirmed: true }),
      });
      expect(migrated.status).toBe(200);
      expect(migrated.body.dataRoot.root).toBe(path.resolve(migratedDataRoot));

      const afterMigration = await api<{ model?: string; baseURL?: string; hasApiKey?: boolean; apiKey?: string }>(
        server,
        '/api/bridge/detect-local?runtime=claude',
      );
      expect(afterMigration.status).toBe(200);
      expect(afterMigration.body).toMatchObject({
        model: 'claude-local-model',
        baseURL: 'https://claude.local',
        hasApiKey: true,
      });
      expect(afterMigration.body.apiKey).toBe('local-secret');

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

      const configured = await api<Record<string, unknown>>(server, '/api/bridge/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'isolated-claude',
          runtime: 'claude',
          execution: 'cli',
          authSource: 'apiKey',
          provider: 'anthropic',
          apiKey: 'child-only-secret',
        }),
      });
      expect(configured.status).toBe(200);
      const configuredJson = JSON.stringify(configured.body);
      expect(configuredJson).toContain('child-only-secret');
      const bridgeState = (configured.body as {
        bridgeState?: { configs?: Array<Record<string, unknown>> };
      }).bridgeState;
      expect(bridgeState?.configs?.[0]).toMatchObject({
        execution: 'cli',
        authSource: 'apiKey',
        hasApiKey: true,
        apiKey: 'child-only-secret',
      });
    } finally {
      await server.close();
    }
  });
});
