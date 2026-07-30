#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, Menu, nativeImage, shell } from 'electron';
import electronUpdater from 'electron-updater';

import {
  parseActoviqGuiArgs,
  startActoviqGuiServer,
  type ActoviqGuiServer,
} from './actoviqGui.js';
import { resolveGuiIconPath } from './guiAssets.js';
import { readPackageVersion } from '../cli/version.js';
import {
  getDefaultActoviqSettingsPath,
  persistActoviqSettingsStore,
} from '../config/actoviqSettingsStore.js';
import { resolveActoviqHome } from '../config/actoviqHome.js';
import {
  createAppUpdateController,
  createUnsupportedAppUpdateController,
  type AppUpdateController,
} from '../update/appUpdateService.js';

let guiServer: ActoviqGuiServer | null = null;
let cleanupInProgress = false;
let quittingAfterCleanup = false;
const { autoUpdater } = electronUpdater;

if (process.platform === 'win32') {
  // Set before 'ready'. Use a stable id distinct from electron.exe's default grouping.
  app.setAppUserModelId('com.actoviq.desktop');
}

function executeInFocusedWindow(script: string): void {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return;
  void focusedWindow.webContents.executeJavaScript(script);
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新对话', accelerator: 'CmdOrCtrl+N', click: () => executeInFocusedWindow("document.getElementById('newSession')?.click()") },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'Actoviq GUI', click: () => executeInFocusedWindow("const input=document.getElementById('promptInput');if(input){input.value='/help';document.getElementById('composer')?.requestSubmit();}") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getUserArgs(): string[] {
  const mainPath = path.resolve(fileURLToPath(import.meta.url));
  const mainIndex = process.argv.findIndex(arg => {
    try {
      return path.resolve(arg) === mainPath;
    } catch {
      return false;
    }
  });
  return mainIndex >= 0 ? process.argv.slice(mainIndex + 1) : process.argv.slice(2);
}

function loadWindowIcon(): { iconPath?: string; iconImage?: Electron.NativeImage } {
  const iconPath = resolveGuiIconPath();
  if (!iconPath || !existsSync(iconPath)) {
    process.stderr.write('[actoviq-gui] warning: app icon not found — run npm run generate:icon\n');
    return {};
  }
  const iconImage = nativeImage.createFromPath(iconPath);
  if (iconImage.isEmpty()) {
    process.stderr.write(`[actoviq-gui] warning: could not decode icon at ${iconPath}\n`);
    return { iconPath };
  }
  return { iconPath, iconImage };
}

/**
 * First-launch init: ensure the Actoviq data root and a minimal `settings.json` exist
 * so the app boots (and the dir is present even if the user hasn't configured
 * a key yet). Idempotent — never overwrites an existing settings file, so a
 * user who already has an npm-installed `~/.actoviq` is left untouched.
 */
async function ensureActoviqHomeInit(args: { homeDir?: string; configPath?: string }): Promise<void> {
  const homeDir = resolveActoviqHome(args.homeDir);
  const configPath = args.configPath ?? getDefaultActoviqSettingsPath(homeDir);
  if (existsSync(configPath)) return;
  try {
    await persistActoviqSettingsStore(configPath, {});
  } catch {
    // best-effort — a failed init must not block app start.
  }
}

function createDesktopAppUpdater(): AppUpdateController {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) {
    return createUnsupportedAppUpdateController(
      currentVersion,
      'Development builds are not replaced automatically. Install a packaged Actoviq release to use Upgrade.',
    );
  }
  if (process.arch !== 'x64') {
    return createUnsupportedAppUpdateController(
      currentVersion,
      `Automatic updates are not published for ${process.arch} yet. Download the matching installer from the release page.`,
    );
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return createUnsupportedAppUpdateController(
      currentVersion,
      'Automatic updates currently support Windows x64 and Linux x64 packaged builds.',
    );
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return createUnsupportedAppUpdateController(
      currentVersion,
      'Linux automatic updates require running the installed AppImage.',
    );
  }
  return createAppUpdateController({
    updater: autoUpdater,
    currentVersion,
    installDownloaded: async () => {
      if (guiServer) {
        await guiServer.close();
        guiServer = null;
      }
      quittingAfterCleanup = true;
      autoUpdater.quitAndInstall(true, true);
    },
  });
}

async function createWindow(): Promise<void> {
  const args = parseActoviqGuiArgs(getUserArgs());
  if (args.version) {
    process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
    app.quit();
    return;
  }
  if (args.help) {
    process.stdout.write([
      'actoviq-gui - Clean SDK Electron desktop UI',
      '',
      'Usage: actoviq-gui [work-dir] [options]',
      '',
      'Options:',
      '  --host <host>              Internal host to bind (default: 127.0.0.1)',
      '  --port <port>              Internal port to bind (default: 4174)',
      '  --config <path>            Load a specific Actoviq settings JSON file',
      '  --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)',
      '  --model <model>            Override the configured model',
      '  --resume <session-id>      Resume a stored Clean SDK session',
      '  --continue                 Resume the most recent stored session',
      '  -v, --version              Show package version',
      '  -h, --help                 Show this help',
      '',
    ].join('\n'));
    app.quit();
    return;
  }

  await ensureActoviqHomeInit(args);
  guiServer = await startActoviqGuiServer({
    ...args,
    appUpdater: createDesktopAppUpdater(),
  });
  installApplicationMenu();
  const { iconPath, iconImage } = loadWindowIcon();
  const hasIcon = Boolean(iconPath && iconImage && !iconImage.isEmpty());
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 620,
    title: 'Actoviq',
    backgroundColor: '#f3f3f3',
    show: false,
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(true);
  if (hasIcon && iconPath) {
    window.setIcon(iconPath);
  }
  window.once('ready-to-show', () => {
    window.show();
    if (hasIcon && iconPath) window.setIcon(iconPath);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL(guiServer.url);
}

app.whenReady().then(() => {
  void createWindow().catch((error) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('before-quit', (event) => {
  if (!guiServer || quittingAfterCleanup) return;
  event.preventDefault();
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  const server = guiServer;
  void server.close().then(() => {
    guiServer = null;
    cleanupInProgress = false;
    quittingAfterCleanup = true;
    app.quit();
  }).catch((error) => {
    cleanupInProgress = false;
    const message =
      `Managed runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}. ` +
      'An E2B sandbox or Playwright session may still be active; check it manually before ' +
      'assuming billing has stopped.';
    process.stderr.write(`[actoviq-gui] ERROR: ${message}\n`);
    dialog.showErrorBox('Actoviq cleanup failed', message);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
