import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { getActoviqHomePointerPath } from '../src/index.js';

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
  const res = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI data root settings', () => {
  it('reports and migrates the Actoviq data root after explicit confirmation', async () => {
    const root = await tempRoot('actoviq-gui-data-root-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const sourceRoot = path.join(homeDir, '.actoviq');
    const targetRoot = path.join(root, 'actoviq-data');
    await mkdir(workDir, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'settings.json'), JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');
    await writeFile(path.join(sourceRoot, 'mcp.json'), JSON.stringify({ servers: [{ name: 'demo', command: 'npx' }] }), 'utf8');

    const port = 44000 + Math.floor(Math.random() * 10000);
    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port,
    });

    try {
      const before = await api<{
        root: string;
        pointerPath: string;
        summary: { entries: number; bytes: number };
        contents: string[];
      }>(
        server,
        'api/settings/data-root',
      );
      expect(before.status).toBe(200);
      expect(before.body.root).toBe(sourceRoot);
      expect(before.body.pointerPath).toBe(getActoviqHomePointerPath(homeDir));
      expect(before.body.summary.entries).toBeGreaterThanOrEqual(2);
      expect(before.body.contents).toEqual(expect.arrayContaining(['mcp.json', 'settings.json']));

      const unconfirmed = await api<{ error: string }>(server, 'api/settings/data-root', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetRoot }),
      });
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.body.error).toContain('Confirmation');

      const migrated = await api<{
        ok: boolean;
        changed: boolean;
        dataRoot: { root: string };
        state: { settings: { dataRoot: { root: string }; configPath: string } };
      }>(server, 'api/settings/data-root', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetRoot, confirmed: true }),
      });
      expect(migrated.status).toBe(200);
      expect(migrated.body.ok).toBe(true);
      expect(migrated.body.changed).toBe(true);
      expect(migrated.body.dataRoot.root).toBe(path.resolve(targetRoot));
      expect(migrated.body.state.settings.dataRoot.root).toBe(path.resolve(targetRoot));
      expect(migrated.body.state.settings.configPath).toBe(path.join(path.resolve(targetRoot), 'settings.json'));

      await expect(readFile(path.join(targetRoot, 'settings.json'), 'utf8')).resolves.toContain('ACTOVIQ_MODEL');
      await expect(readFile(path.join(targetRoot, 'mcp.json'), 'utf8')).resolves.toContain('demo');
      const pointer = JSON.parse(await readFile(getActoviqHomePointerPath(homeDir), 'utf8')) as { root: string };
      expect(pointer.root).toBe(path.resolve(targetRoot));

      const after = await api<{ root: string }>(server, 'api/settings/data-root');
      expect(after.body.root).toBe(path.resolve(targetRoot));
    } finally {
      await server.close();
    }
  });
});
