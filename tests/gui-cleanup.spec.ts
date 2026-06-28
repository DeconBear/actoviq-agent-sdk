import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { getActoviqProjectSessionDirectory, SessionStore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createWorkspace(root: string, name: string): Promise<string> {
  const workspace = path.join(root, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

describe('GUI session cleanup', () => {
  it('auto-cleans empty sessions when state is recomputed, keeping non-empty ones', async () => {
    const root = await tempDir('actoviq-gui-acln-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');

    // Pre-seed: one empty session + one non-empty session.
    const store = new SessionStore(getActoviqProjectSessionDirectory(workA, homeDir));
    await store.create({ id: 'empty-a', metadata: { __actoviqWorkDir: workA } });
    await store.create({
      id: 'keep-a',
      metadata: { __actoviqWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'keep me' }],
    });

    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const port = 45000 + Math.floor(Math.random() * 10000);
    const server = await startActoviqGuiServer({
      workDir: workA,
      homeDir,
      host: '127.0.0.1',
      port,
      configPath,
    });
    const authHeaders = { 'x-actoviq-token': server.token };
    try {
      // The first /api/state call recomputes the heavy cache → auto-cleans
      // empty sessions (except the active one, which is the server's own fresh
      // 0-message session, excluded from cleanup).
      const state = await fetch(`${server.url}api/state`, { headers: authHeaders })
        .then((res) => res.json()) as {
          projects: Array<{ path: string; sessionCount: number }>;
        };

      // hiddenEmptySessionCount is no longer in the state — auto-clean has
      // already removed orphaned empty sessions.
      expect(state).toHaveProperty('projects');
      expect(state).not.toHaveProperty('hiddenEmptySessionCount');

      // The empty session should be gone from disk.
      await expect(store.load('empty-a')).rejects.toThrow();
      // The non-empty session must survive.
      expect((await store.load('keep-a')).messages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
