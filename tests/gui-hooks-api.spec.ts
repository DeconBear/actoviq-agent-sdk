import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('GUI hooks API', () => {
  it('updates typed hooks without replacing legacy hooks and rejects invalid definitions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-hooks-'));
    tempDirs.push(root);
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    const configPath = path.join(homeDir, 'settings.json');
    await mkdir(workDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      hooks: { SessionStart: [{ command: 'echo legacy' }] },
    }));
    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      configPath,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    const request = async (method: string, body?: unknown) => {
      const response = await fetch(new URL('api/hooks', server.url), {
        method,
        headers: {
          'x-hadamard-token': server.token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      const saved = await request('PUT', {
        typedHooks: [{
          id: 'audit',
          event: 'PostToolUse',
          matcher: '^Bash$',
          handler: { type: 'http', url: 'http://127.0.0.1:9000/hook' },
          timeoutMs: 5000,
          errorPolicy: 'continue',
        }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body.typedHooks).toHaveLength(1);
      expect(saved.body.hooks.SessionStart).toEqual([{ command: 'echo legacy' }]);

      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      expect(persisted.hooks.SessionStart).toEqual([{ command: 'echo legacy' }]);
      expect(persisted.typedHooks[0].id).toBe('audit');

      const rejected = await request('PUT', {
        typedHooks: [
          { id: 'same', event: 'TurnStart', handler: { type: 'prompt', prompt: 'ok' } },
          { id: 'same', event: 'TurnEnd', handler: { type: 'prompt', prompt: 'no' } },
        ],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('duplicates');

      const loaded = await request('GET');
      expect(loaded.status).toBe(200);
      expect(loaded.body.typedHooks.map((hook: { id: string }) => hook.id)).toEqual(['audit']);
      expect(loaded.body.typedHookIssues).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
