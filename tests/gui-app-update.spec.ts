import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import type { AppUpdateController, AppUpdateSnapshot } from '../src/update/appUpdateService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function request(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  pathname: string,
  method = 'GET',
): Promise<Response> {
  return fetch(new URL(pathname.replace(/^\/+/, ''), server.url), {
    method,
    headers: { 'x-hadamard-token': server.token },
  });
}

describe('GUI app updates', () => {
  it('exposes update state and installs only after the explicit Upgrade action', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-update-api-'));
    tempDirs.push(root);
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    await Promise.all([
      mkdir(workDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    let state: AppUpdateSnapshot = {
      supported: true,
      state: 'idle',
      currentVersion: '1.0.0',
    };
    const install = vi.fn(async () => undefined);
    const appUpdater: AppUpdateController = {
      snapshot: () => ({ ...state }),
      check: vi.fn(async () => {
        state = {
          supported: true,
          state: 'available',
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
        };
        return { ...state };
      }),
      download: vi.fn(async () => {
        state = { ...state, state: 'downloaded', percent: 100 };
        return { ...state };
      }),
      install,
    };
    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      appUpdater,
      host: '127.0.0.1',
      port: 47000 + Math.floor(Math.random() * 1000),
    });
    try {
      const initial = await request(server, '/api/app-update');
      expect(await initial.json()).toMatchObject({ state: 'idle', currentVersion: '1.0.0' });
      expect(install).not.toHaveBeenCalled();

      const checked = await request(server, '/api/app-update/check', 'POST');
      expect(checked.status).toBe(200);
      expect(await checked.json()).toMatchObject({ state: 'available', latestVersion: '1.1.0' });

      const upgraded = await request(server, '/api/app-update/upgrade', 'POST');
      expect(upgraded.status).toBe(200);
      expect(await upgraded.json()).toMatchObject({ state: 'downloaded', percent: 100 });
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce(), { timeout: 2_000 });

      const page = await fetch(server.url).then(response => response.text());
      expect(page).toContain('id="settingsUpdateCheck"');
      expect(page).toContain('id="settingsUpdateUpgrade"');
    } finally {
      await server.close();
    }
  });
});
