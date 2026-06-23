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
  it('cleans empty chats across known workspaces and keeps non-empty chats', async () => {
    const root = await tempDir('actoviq-gui-cleanup-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');
    const workB = await createWorkspace(root, 'work-b');

    const storeA = new SessionStore(getActoviqProjectSessionDirectory(workA, homeDir));
    const storeB = new SessionStore(getActoviqProjectSessionDirectory(workB, homeDir));
    await storeA.create({ id: 'empty-a', metadata: { __actoviqWorkDir: workA } });
    await storeA.create({
      id: 'keep-a',
      metadata: { __actoviqWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'keep this chat' }],
    });
    await storeB.create({ id: 'empty-b', metadata: { __actoviqWorkDir: workB } });
    await storeB.create({
      id: 'keep-b',
      metadata: { __actoviqWorkDir: workB },
      initialMessages: [{ role: 'user', content: 'keep this other chat' }],
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
      const before = await fetch(`${server.url}api/state`, { headers: authHeaders }).then((res) => res.json()) as {
        hiddenEmptySessionCount: number;
        projects: Array<{ path: string; sessionCount: number }>;
      };
      expect(before.hiddenEmptySessionCount).toBe(2);
      expect(before.projects.find((project) => project.path === workA)?.sessionCount).toBe(1);
      expect(before.projects.find((project) => project.path === workB)?.sessionCount).toBe(1);

      const cleaned = await fetch(`${server.url}api/sessions/cleanup`, { method: 'POST', headers: authHeaders })
        .then((res) => res.json()) as { deleted: number; state: { hiddenEmptySessionCount: number } };
      expect(cleaned.deleted).toBe(2);
      expect(cleaned.state.hiddenEmptySessionCount).toBe(0);

      await expect(storeA.load('empty-a')).rejects.toThrow();
      await expect(storeB.load('empty-b')).rejects.toThrow();
      expect((await storeA.load('keep-a')).messages).toHaveLength(1);
      expect((await storeB.load('keep-b')).messages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
