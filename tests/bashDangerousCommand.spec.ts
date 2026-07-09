import { describe, expect, it } from 'vitest';

import { detectDangerousBashCommand } from '../src/tools/bash/BashTool.js';

describe('detectDangerousBashCommand', () => {
  it('blocks taskkill by image name for node/bun/deno', () => {
    expect(detectDangerousBashCommand('taskkill //F //IM node.exe')).toMatch(/Blocked/);
    expect(detectDangerousBashCommand('taskkill /F /IM node.exe')).toMatch(/Blocked/);
    expect(detectDangerousBashCommand('taskkill /IM bun.exe /F')).toMatch(/Blocked/);
    expect(detectDangerousBashCommand('taskkill /FI "IMAGENAME eq node.exe" /F')).toMatch(/Blocked/);
  });

  it('allows taskkill by specific PID', () => {
    expect(detectDangerousBashCommand('taskkill /PID 12345 /F')).toBeNull();
  });

  it('blocks killall / broad pkill of node', () => {
    expect(detectDangerousBashCommand('killall node')).toMatch(/Blocked/);
    expect(detectDangerousBashCommand('pkill -f node')).toMatch(/Blocked/);
  });

  it('blocks PowerShell Stop-Process by process name', () => {
    expect(detectDangerousBashCommand('Stop-Process -Name node -Force')).toMatch(/Blocked/);
    expect(detectDangerousBashCommand("Stop-Process -ProcessName 'node.exe'")).toMatch(/Blocked/);
  });

  it('allows ordinary commands', () => {
    expect(detectDangerousBashCommand('npm start')).toBeNull();
    expect(detectDangerousBashCommand('curl http://localhost:3000/api/events')).toBeNull();
    expect(detectDangerousBashCommand('kill 12345')).toBeNull();
    expect(detectDangerousBashCommand('Stop-Process -Id 12345 -Force')).toBeNull();
  });
});
