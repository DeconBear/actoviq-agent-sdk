import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHadamardHome } from '../src/config/hadamardHome.js';
import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function api<T>(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(new URL(requestPath.replace(/^\/+/, ''), server.url), {
    ...init,
    headers: { 'x-hadamard-token': server.token, ...init.headers },
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T, text };
}

describe('GUI Customize plugins API', () => {
  it('installs and configures managed plugins without returning secrets to the renderer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-plugins-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 46000 + Math.floor(Math.random() * 8000),
    });

    type Snapshot = {
      plugins: Array<{
        id: string;
        enabled: boolean;
        state: string;
        secretConfigured: boolean;
        config: Record<string, unknown>;
      }>;
      localPlugins: unknown[];
    };

    try {
      const initial = await api<Snapshot>(server, '/api/customize/plugins');
      expect(initial.status).toBe(200);
      expect(initial.body.plugins.map(plugin => plugin.id)).toEqual([
        'ocr',
        'computer-use',
        'github',
        'kimi-webbridge',
        'playwright',
        'tavily',
        'exa',
        'image-gen',
        'video-gen',
        'mesh-gen',
      ]);
      expect(initial.body.plugins.every(plugin => plugin.state === 'available')).toBe(true);

      const installed = await api<Snapshot>(server, '/api/customize/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install', id: 'ocr' }),
      });
      expect(installed.status).toBe(200);
      expect(installed.body.plugins.find(plugin => plugin.id === 'ocr')).toMatchObject({
        enabled: true,
        state: 'needs-setup',
        secretConfigured: false,
      });

      const secret = 'dashscope-super-secret';
      const configured = await api<Snapshot>(server, '/api/customize/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          id: 'ocr',
          enabled: true,
          config: {
            provider: 'qwen',
            api: 'responses',
            model: 'qwen3.5-ocr',
            apiKey: secret,
          },
        }),
      });
      expect(configured.status).toBe(200);
      expect(configured.body.plugins.find(plugin => plugin.id === 'ocr')).toMatchObject({
        state: 'ready',
        secretConfigured: true,
        config: { provider: 'qwen', api: 'responses', model: 'qwen3.5-ocr' },
      });
      expect(configured.text).not.toContain(secret);
      expect(configured.body.plugins.find(plugin => plugin.id === 'ocr')?.config)
        .not.toHaveProperty('apiKey');

      const settings = await readFile(
        path.join(resolveHadamardHome(homeDir), 'settings.json'),
        'utf8',
      );
      expect(settings).toContain(secret);

      const retained = await api<Snapshot>(server, '/api/customize/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          id: 'ocr',
          config: { apiKey: '', prompt: 'Preserve tables.' },
        }),
      });
      expect(retained.body.plugins.find(plugin => plugin.id === 'ocr')).toMatchObject({
        secretConfigured: true,
      });
      expect(retained.text).not.toContain(secret);
    } finally {
      await server.close();
    }
  });
});
