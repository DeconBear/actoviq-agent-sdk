import { describe, expect, it } from 'vitest';

import {
  isWindowsTerminalShellPreference,
  resolveDefaultShell,
} from '../src/gui/terminalManager.js';

describe('terminal default shell', () => {
  it('defaults Windows terminals to PowerShell', () => {
    expect(resolveDefaultShell({ platform: 'win32' })).toEqual({
      file: 'powershell.exe',
      args: ['-NoLogo'],
    });
  });

  it('allows Windows users to prefer cmd', () => {
    expect(resolveDefaultShell({
      platform: 'win32',
      windowsShell: 'cmd',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    })).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
    });
  });

  it('keeps POSIX shells on Linux and macOS', () => {
    expect(resolveDefaultShell({
      platform: 'linux',
      shellEnv: '/bin/zsh',
      windowsShell: 'cmd',
    })).toEqual({
      file: '/bin/zsh',
      args: [],
    });
    expect(resolveDefaultShell({
      platform: 'darwin',
      shellEnv: '/bin/bash',
    })).toEqual({
      file: '/bin/bash',
      args: [],
    });
  });

  it('validates Windows shell preferences', () => {
    expect(isWindowsTerminalShellPreference('powershell')).toBe(true);
    expect(isWindowsTerminalShellPreference('cmd')).toBe(true);
    expect(isWindowsTerminalShellPreference('bash')).toBe(false);
  });
});
