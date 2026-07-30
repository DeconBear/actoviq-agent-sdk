export type AppUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported';

export interface AppUpdateSnapshot {
  supported: boolean;
  state: AppUpdateState;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
  reason?: string;
}

export interface AppUpdateController {
  snapshot(): AppUpdateSnapshot;
  check(): Promise<AppUpdateSnapshot>;
  download(): Promise<AppUpdateSnapshot>;
  install(): Promise<void>;
}

interface NativeUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ note?: string | null }> | null;
}

interface NativeProgressInfo {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface NativeAppUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available', listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (info: NativeProgressInfo) => void): unknown;
  on(event: 'update-downloaded', listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo?: NativeUpdateInfo } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

function releaseNotesText(value: NativeUpdateInfo['releaseNotes']): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const notes = value
    .map(item => typeof item.note === 'string' ? item.note.trim() : '')
    .filter(Boolean);
  return notes.length > 0 ? notes.join('\n\n') : undefined;
}

function updateDetails(info: NativeUpdateInfo): Pick<AppUpdateSnapshot, 'latestVersion' | 'releaseName' | 'releaseNotes'> {
  return {
    latestVersion: info.version,
    ...(info.releaseName ? { releaseName: info.releaseName } : {}),
    ...(releaseNotesText(info.releaseNotes) ? { releaseNotes: releaseNotesText(info.releaseNotes) } : {}),
  };
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value
    .trim()
    .replace(/^v/i, '')
    .split(/[+-]/, 1)[0]!
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(part => Number.isFinite(part) ? part : 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function createUnsupportedAppUpdateController(
  currentVersion: string,
  reason: string,
): AppUpdateController {
  const state: AppUpdateSnapshot = {
    supported: false,
    state: 'unsupported',
    currentVersion,
    reason,
  };
  const unsupported = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    snapshot: () => ({ ...state }),
    check: unsupported,
    download: unsupported,
    install: unsupported,
  };
}

export function createAppUpdateController(options: {
  updater: NativeAppUpdater;
  currentVersion: string;
  installDownloaded?: () => Promise<void>;
}): AppUpdateController {
  const { updater } = options;
  let checkPromise: Promise<AppUpdateSnapshot> | undefined;
  let downloadPromise: Promise<AppUpdateSnapshot> | undefined;
  let installPromise: Promise<void> | undefined;
  let state: AppUpdateSnapshot = {
    supported: true,
    state: 'idle',
    currentVersion: options.currentVersion,
  };

  const patch = (next: Partial<AppUpdateSnapshot>): void => {
    state = { ...state, ...next };
  };
  const fail = (error: unknown): void => {
    patch({
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  };

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = null;
  updater.on('checking-for-update', () => patch({ state: 'checking', error: undefined }));
  updater.on('update-available', info => patch({
    state: 'available',
    error: undefined,
    ...updateDetails(info),
  }));
  updater.on('update-not-available', info => patch({
    state: 'not-available',
    error: undefined,
    ...updateDetails(info),
  }));
  updater.on('download-progress', info => patch({
    state: 'downloading',
    percent: info.percent,
    transferred: info.transferred,
    total: info.total,
    bytesPerSecond: info.bytesPerSecond,
    error: undefined,
  }));
  updater.on('update-downloaded', info => patch({
    state: 'downloaded',
    percent: 100,
    error: undefined,
    ...updateDetails(info),
  }));
  updater.on('error', fail);

  return {
    snapshot: () => ({ ...state }),
    check: () => {
      if (checkPromise) return checkPromise;
      checkPromise = (async () => {
        patch({
          state: 'checking',
          error: undefined,
          percent: undefined,
          transferred: undefined,
          total: undefined,
          bytesPerSecond: undefined,
        });
        try {
          const result = await updater.checkForUpdates();
          if (state.state === 'checking') {
            const info = result?.updateInfo;
            patch(info && compareVersions(info.version, options.currentVersion) > 0
              ? { state: 'available', ...updateDetails(info) }
              : {
                  state: 'not-available',
                  ...(info ? updateDetails(info) : {}),
                });
          }
          return { ...state };
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          checkPromise = undefined;
        }
      })();
      return checkPromise;
    },
    download: () => {
      if (state.state === 'downloaded') return Promise.resolve({ ...state });
      if (downloadPromise) return downloadPromise;
      if (state.state !== 'available') {
        return Promise.reject(new Error('Check for an available update before upgrading.'));
      }
      downloadPromise = (async () => {
        patch({ state: 'downloading', percent: 0, error: undefined });
        try {
          await updater.downloadUpdate();
          if (state.state === 'downloading') patch({ state: 'downloaded', percent: 100 });
          return { ...state };
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          downloadPromise = undefined;
        }
      })();
      return downloadPromise;
    },
    install: () => {
      if (installPromise) return installPromise;
      if (state.state !== 'downloaded') {
        return Promise.reject(new Error('The update has not finished downloading.'));
      }
      installPromise = (async () => {
        patch({ state: 'installing', error: undefined });
        try {
          if (options.installDownloaded) {
            await options.installDownloaded();
          } else {
            updater.quitAndInstall(false, true);
          }
        } catch (error) {
          fail(error);
          throw error;
        }
      })();
      return installPromise;
    },
  };
}
