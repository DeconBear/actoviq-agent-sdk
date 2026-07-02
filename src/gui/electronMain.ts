#!/usr/bin/env node
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, Menu, nativeImage, shell } from 'electron';

import {
  parseActoviqGuiArgs,
  startActoviqGuiServer,
  type ActoviqGuiServer,
} from './actoviqGui.js';
import { readPackageVersion } from '../cli/version.js';
import {
  getDefaultActoviqSettingsPath,
  persistActoviqSettingsStore,
} from '../config/actoviqSettingsStore.js';

let guiServer: ActoviqGuiServer | null = null;

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

function resolveIconPath(): string | undefined {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // When packaged, an asset inside app.asar is transparently readable from
  // the app.asar/... virtual path, BUT Win32 LoadImage (used by setIcon and
  // the BrowserWindow `icon` option to read .ico) can't read through asar's
  // virtual FS — the icon silently fails to apply and falls back to the
  // Electron default. Resolve asar paths to their real app.asar.unpacked/...
  // location when the asset is unpacked (see package.json asarUnpack).
  const realPath = (p: string): string => p.includes('\\app.asar\\')
    ? p.replace('\\app.asar\\', '\\app.asar.unpacked\\')
    : (p.includes('/app.asar/') ? p.replace('/app.asar/', '/app.asar.unpacked/') : p);
  const pngs = [
    path.join(dir, '../../../assets/actoviq-icon.png'), // dist/src/gui -> repo/assets
    path.join(dir, '../../assets/actoviq-icon.png'), // src/gui (tsx) -> repo/assets
    path.join(process.cwd(), 'assets', 'actoviq-icon.png'),
  ];
  if (process.platform === 'win32') {
    const icos = [
      path.join(dir, '../../../assets/actoviq-icon.ico'), // dist/src/gui -> repo/assets
      path.join(process.cwd(), 'assets', 'actoviq-icon.ico'),
    ];
    const ico = icos.find((c) => existsSync(c) || existsSync(realPath(c)));
    if (ico) return existsSync(realPath(ico)) ? realPath(ico) : ico;
  }
  return pngs.find((candidate) => existsSync(candidate) || existsSync(realPath(candidate)));
}

/**
 * First-launch init: ensure `~/.actoviq/` and a minimal `settings.json` exist
 * so the app boots (and the dir is present even if the user hasn't configured
 * a key yet). Idempotent — never overwrites an existing settings file, so a
 * user who already has an npm-installed `~/.actoviq` is left untouched.
 */
async function ensureActoviqHomeInit(args: { homeDir?: string; configPath?: string }): Promise<void> {
  const homeDir = args.homeDir ?? os.homedir();
  const configPath = args.configPath ?? getDefaultActoviqSettingsPath(homeDir);
  if (existsSync(configPath)) return;
  try {
    await persistActoviqSettingsStore(configPath, {});
  } catch {
    // best-effort — a failed init must not block app start.
  }
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
  guiServer = await startActoviqGuiServer(args);
  installApplicationMenu();
  app.setAppUserModelId('com.actoviq.gui');
  const iconPath = resolveIconPath();
  // Build a NativeImage once and reuse it. On Windows, passing a path string
  // to setIcon / the `icon` option is unreliable for the taskbar (Win32 LoadImage
  // + icon caching by exe path can leave the electron.exe icon showing). A
  // NativeImage decoded from the .ico applies consistently to both the title
  // bar and the taskbar, in dev (electron.exe) and packaged (Actoviq.exe) runs.
  const iconImage = iconPath ? nativeImage.createFromPath(iconPath) : null;
  const hasIcon = iconImage && !iconImage.isEmpty();
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 620,
    title: 'Actoviq',
    backgroundColor: '#f3f3f3',
    show: false,
    ...(hasIcon ? { icon: iconImage } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(true);
  if (hasIcon) window.setIcon(iconImage);
  window.once('ready-to-show', () => {
    window.show();
    // Re-apply after the window is visible: Windows sometimes drops the
    // taskbar icon that was set before the window was shown.
    if (hasIcon) window.setIcon(iconImage);
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
  if (!guiServer) return;
  event.preventDefault();
  const server = guiServer;
  guiServer = null;
  void server.close().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
