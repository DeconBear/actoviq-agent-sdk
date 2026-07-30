import { describe, expect, it, vi } from 'vitest';

import {
  createAppUpdateController,
  createUnsupportedAppUpdateController,
  type NativeAppUpdater,
} from '../src/update/appUpdateService.js';

function fakeUpdater() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    logger: console,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
      return updater;
    }),
    checkForUpdates: vi.fn(async () => {
      const info = { version: '1.2.0', releaseName: 'Actoviq 1.2' };
      listeners.get('update-available')?.(info);
      return { updateInfo: info };
    }),
    downloadUpdate: vi.fn(async () => {
      listeners.get('download-progress')?.({
        percent: 54,
        transferred: 54,
        total: 100,
        bytesPerSecond: 20,
      });
      listeners.get('update-downloaded')?.({ version: '1.2.0' });
      return ['Actoviq.exe'];
    }),
    quitAndInstall: vi.fn(),
  } as unknown as NativeAppUpdater;
  return { updater, listeners };
}

describe('app update service', () => {
  it('reports unsupported launches without attempting an update', async () => {
    const controller = createUnsupportedAppUpdateController('1.0.0', 'Packaged builds only');
    expect(controller.snapshot()).toMatchObject({
      supported: false,
      state: 'unsupported',
      currentVersion: '1.0.0',
    });
    await expect(controller.check()).rejects.toThrow('Packaged builds only');
  });

  it('checks, downloads, and hands off installation explicitly', async () => {
    const { updater } = fakeUpdater();
    const installDownloaded = vi.fn(async () => undefined);
    const controller = createAppUpdateController({
      updater,
      currentVersion: '1.0.0',
      installDownloaded,
    });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);

    await expect(controller.download()).rejects.toThrow('Check for an available update');
    await expect(controller.check()).resolves.toMatchObject({
      state: 'available',
      latestVersion: '1.2.0',
    });
    await expect(controller.download()).resolves.toMatchObject({
      state: 'downloaded',
      latestVersion: '1.2.0',
      percent: 100,
    });
    await controller.install();
    expect(controller.snapshot().state).toBe('installing');
    expect(installDownloaded).toHaveBeenCalledOnce();
  });

  it('keeps check failures visible to the UI', async () => {
    const { updater } = fakeUpdater();
    vi.mocked(updater.checkForUpdates).mockRejectedValueOnce(new Error('release endpoint unavailable'));
    const controller = createAppUpdateController({ updater, currentVersion: '1.0.0' });

    await expect(controller.check()).rejects.toThrow('release endpoint unavailable');
    expect(controller.snapshot()).toMatchObject({
      state: 'error',
      error: 'release endpoint unavailable',
    });
  });

  it('uses the returned version when the native updater does not emit an availability event', async () => {
    const { updater } = fakeUpdater();
    vi.mocked(updater.checkForUpdates).mockResolvedValueOnce({
      updateInfo: { version: '1.10.0', releaseName: 'Actoviq 1.10' },
    });
    const controller = createAppUpdateController({ updater, currentVersion: '1.9.9' });

    await expect(controller.check()).resolves.toMatchObject({
      state: 'available',
      latestVersion: '1.10.0',
    });
  });

  it('coalesces repeated update operations and surfaces install failures', async () => {
    const { updater, listeners } = fakeUpdater();
    let finishCheck!: () => void;
    vi.mocked(updater.checkForUpdates).mockImplementationOnce(() => new Promise(resolve => {
      finishCheck = () => {
        const info = { version: '1.2.0' };
        listeners.get('update-available')?.(info);
        resolve({ updateInfo: info });
      };
    }));
    const installDownloaded = vi.fn(async () => {
      throw new Error('installer handoff failed');
    });
    const controller = createAppUpdateController({
      updater,
      currentVersion: '1.0.0',
      installDownloaded,
    });

    const first = controller.check();
    const second = controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    finishCheck();
    await Promise.all([first, second]);

    const firstDownload = controller.download();
    const secondDownload = controller.download();
    await Promise.all([firstDownload, secondDownload]);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();

    const firstInstall = controller.install();
    const secondInstall = controller.install();
    await expect(firstInstall).rejects.toThrow('installer handoff failed');
    await expect(secondInstall).rejects.toThrow('installer handoff failed');
    expect(installDownloaded).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({
      state: 'error',
      error: 'installer handoff failed',
    });
  });
});
