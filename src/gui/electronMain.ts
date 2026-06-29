#!/usr/bin/env node
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, Menu, shell } from 'electron';

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
  const candidates = [
    path.join(dir, '../../../assets/actoviq-icon.png'), // dist/src/gui -> repo/assets
    path.join(dir, '../../assets/actoviq-icon.png'), // src/gui (tsx) -> repo/assets
    path.join(process.cwd(), 'assets', 'actoviq-icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
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
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 620,
    title: 'Actoviq',
    backgroundColor: '#f3f3f3',
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(true);
  window.once('ready-to-show', () => window.show());
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
