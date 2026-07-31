import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { readWorkspaceRegistry } from '../src/gui/workspaceRegistry.js';

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

describe('GUI projects bootstrap', () => {
  it('keeps Projects empty when launched without an explicit workDir', async () => {
    const root = await tempRoot('hadamard-gui-empty-projects-');
    const homeDir = path.join(root, 'home');
    await mkdir(homeDir, { recursive: true });
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1',
        HADAMARD_MODEL: 'model-default',
      },
    }), 'utf8');

    const previousCwd = process.cwd();
    const installLikeCwd = path.join(root, 'HadamardInstall');
    await mkdir(installLikeCwd, { recursive: true });
    process.chdir(installLikeCwd);
    try {
      const server = await startHadamardGuiServer({
        homeDir,
        configPath,
        host: '127.0.0.1',
        port: 45000 + Math.floor(Math.random() * 10000),
      });
      try {
        const state = await api<{
          projects: Array<{ path: string }>;
        }>(server, 'api/state');
        expect(state.status).toBe(200);
        expect(state.body.projects).toEqual([]);
        expect(await readWorkspaceRegistry(homeDir)).toEqual([]);
      } finally {
        await server.close();
      }
    } finally {
      process.chdir(previousCwd);
    }
  }, 30_000);

  it('registers a project only after the user opens a folder', async () => {
    const root = await tempRoot('hadamard-gui-open-registers-');
    const homeDir = path.join(root, 'home');
    const project = path.join(root, 'user-project');
    await mkdir(homeDir, { recursive: true });
    await mkdir(project, { recursive: true });
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1',
        HADAMARD_MODEL: 'model-default',
      },
    }), 'utf8');

    const server = await startHadamardGuiServer({
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    try {
      const before = await api<{ projects: Array<{ path: string }> }>(server, 'api/state');
      expect(before.body.projects).toEqual([]);

      const opened = await api<{
        projects: Array<{ path: string }>;
      }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project }),
      });
      expect(opened.status).toBe(200);
      expect(opened.body.projects.map(item => path.normalize(item.path)))
        .toEqual([path.normalize(project)]);

      const raw = await readWorkspaceRegistry(homeDir);
      expect(raw.map(item => path.normalize(item.path)))
        .toEqual([path.normalize(project)]);
    } finally {
      await server.close();
    }
  }, 30_000);
});
