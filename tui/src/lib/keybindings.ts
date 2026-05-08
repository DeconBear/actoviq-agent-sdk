import fs from 'node:fs';
import path from 'node:path';

// ── Keybinding types ────────────────────────────────────────────

export interface KeybindingDef {
  key: string;
  description: string;
  action: string;
}

export interface KeybindingConfig {
  submit: string;
  abort: string;
  toggleOverlay: string;
  clearScreen: string;
  cyclePermissionMode: string;
  navigateUp: string;
  navigateDown: string;
  permissionYes: string;
  permissionNo: string;
}

// ── Default bindings ────────────────────────────────────────────

export const DEFAULT_BINDINGS: KeybindingConfig = {
  submit: 'Ctrl+Enter',
  abort: 'Ctrl+C',
  toggleOverlay: 'Ctrl+O',
  clearScreen: 'Ctrl+L',
  cyclePermissionMode: 'Ctrl+P',
  navigateUp: 'Up',
  navigateDown: 'Down',
  permissionYes: 'y',
  permissionNo: 'n',
};

// ── Load from file ──────────────────────────────────────────────

export function loadKeybindings(homeDir?: string): KeybindingConfig {
  const base = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  const configPath = path.join(base, '.actoviq', 'keybindings.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const user = JSON.parse(raw) as Partial<KeybindingConfig>;
    return { ...DEFAULT_BINDINGS, ...user };
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

// ── Parse helpers ───────────────────────────────────────────────

export function describeBinding(config: KeybindingConfig): string {
  return [
    `Enter: Send`,
    `${config.abort}: Abort`,
    `${config.clearScreen}: Clear`,
    `${config.cyclePermissionMode}: Perm Mode`,
    `${config.toggleOverlay}: Overlay`,
  ].join('  |  ');
}

export function listBindings(config: KeybindingConfig): KeybindingDef[] {
  return [
    { key: config.submit, description: 'Submit message', action: 'submit' },
    { key: config.abort, description: 'Abort stream / quit', action: 'abort' },
    { key: config.toggleOverlay, description: 'Toggle overlay panel', action: 'toggleOverlay' },
    { key: config.clearScreen, description: 'Clear screen', action: 'clearScreen' },
    { key: config.cyclePermissionMode, description: 'Cycle permission mode', action: 'cyclePermissionMode' },
    { key: config.navigateUp, description: 'Navigate history up', action: 'navigateUp' },
    { key: config.navigateDown, description: 'Navigate history down', action: 'navigateDown' },
    { key: config.permissionYes, description: 'Allow tool (in permission dialog)', action: 'permissionYes' },
    { key: config.permissionNo, description: 'Deny tool (in permission dialog)', action: 'permissionNo' },
  ];
}
