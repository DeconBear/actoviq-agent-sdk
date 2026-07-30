import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';

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

describe('GUI workspace open', () => {
  it('opens quoted and file:// workspace paths', async () => {
    const root = await tempRoot('actoviq-gui-workspace-open-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const other = path.join(root, 'other-project');
    await mkdir(workDir, { recursive: true });
    await mkdir(other, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, 'settings.json'), JSON.stringify({
      env: {
        ACTOVIQ_PROVIDER: 'openai',
        ACTOVIQ_API_KEY: 'test-key',
        ACTOVIQ_BASE_URL: 'http://127.0.0.1:1/v1',
        ACTOVIQ_MODEL: 'model-default',
      },
    }), 'utf8');

    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      configPath: path.join(homeDir, 'settings.json'),
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      const quoted = await api<{ workDir: string }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `"${other}"` }),
      });
      expect(quoted.status).toBe(200);
      expect(path.normalize(quoted.body.workDir)).toBe(path.normalize(other));

      const fileUri = await api<{ workDir: string }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: pathToFileURL(workDir).href }),
      });
      expect(fileUri.status).toBe(200);
      expect(path.normalize(fileUri.body.workDir)).toBe(path.normalize(workDir));

      const missing = await api<{ error: string }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(root, 'does-not-exist') }),
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/does not exist/i);

      const asFile = path.join(root, 'not-a-dir.txt');
      await writeFile(asFile, 'x', 'utf8');
      const filePath = await api<{ error: string }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: asFile }),
      });
      expect(filePath.status).toBe(400);
      expect(filePath.body.error).toMatch(/not a directory/i);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('keeps additional work paths under one project and one session root', async () => {
    const root = await tempRoot('actoviq-gui-multi-work-path-');
    const homeDir = path.join(root, 'home');
    const primary = path.join(root, 'product');
    const docs = path.join(root, 'product-docs');
    await Promise.all([
      mkdir(primary, { recursive: true }),
      mkdir(docs, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      env: {
        ACTOVIQ_PROVIDER: 'openai',
        ACTOVIQ_API_KEY: 'test-key',
        ACTOVIQ_BASE_URL: 'http://127.0.0.1:1/v1',
        ACTOVIQ_MODEL: 'model-default',
      },
    }), 'utf8');

    const server = await startActoviqGuiServer({
      workDir: primary,
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    try {
      const added = await api<{
        state: { projectPath: string; projectWorkPaths: string[] };
      }>(server, 'api/project/work-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          projectPath: primary,
          workPath: docs,
        }),
      });
      expect(added.status).toBe(200);
      expect(path.normalize(added.body.state.projectPath)).toBe(path.normalize(primary));
      expect(added.body.state.projectWorkPaths.map(item => path.normalize(item)))
        .toEqual([path.normalize(primary), path.normalize(docs)]);

      const configured = await api<{ config: { readScope: string } }>(
        server,
        'api/manager/config',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'project', readScope: 'workspace+docs' }),
        },
      );
      expect(configured.status).toBe(200);
      await api(server, 'api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ milestones: [{ title: 'Shared' }], today: [], upcoming: [] }),
      });

      const opened = await api<{
        workDir: string;
        projectPath: string;
        projectWorkPaths: string[];
        projects: Array<{ path: string; workPaths: string[]; active: boolean }>;
      }>(server, 'api/project/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: docs }),
      });
      expect(opened.status).toBe(200);
      expect(path.normalize(opened.body.workDir)).toBe(path.normalize(docs));
      expect(path.normalize(opened.body.projectPath)).toBe(path.normalize(primary));
      expect(opened.body.projects.filter(project => project.active)).toHaveLength(1);
      expect(opened.body.projects.filter(project =>
        project.workPaths.some(item => path.normalize(item) === path.normalize(docs))
      )).toHaveLength(1);
      const manager = await api<{
        currentProjectPath: string;
        activeWorkPath: string;
        config: { readScope: string };
      }>(server, 'api/manager/state?scope=project');
      expect(path.normalize(manager.body.currentProjectPath)).toBe(path.normalize(primary));
      expect(path.normalize(manager.body.activeWorkPath)).toBe(path.normalize(docs));
      expect(manager.body.config.readScope).toBe('workspace+docs');
      const plan = await api<{ milestones: Array<{ title: string }> }>(server, 'api/plan');
      expect(plan.body.milestones).toEqual([{ title: 'Shared' }]);
    } finally {
      await server.close();
    }
  }, 30_000);
});
