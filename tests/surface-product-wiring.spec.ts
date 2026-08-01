import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCT_SURFACES = [
  ['src/cli/hadamard-react.ts', 'cli'],
  ['src/tui/hadamardTui.ts', 'tui'],
  ['src/gui/hadamardGui.ts', 'gui'],
  ['src/parity/hadamardCleanBridgeCompatSdk.ts', 'bridge'],
] as const;

describe('product RunEvent wiring boundary', () => {
  it.each(PRODUCT_SURFACES)('%s projects legacy events through shared %s semantics', async (file, target) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');

    expect(source).toContain('LegacySurfaceEventPipeline');
    expect(source).toContain('new LegacySurfaceEventPipeline(');
    expect(source).toMatch(new RegExp(`\\.projectFor\\([^)]*, ['\"]${target}['\"]\\)`));
  });

  it('keeps the native bridge as an AgentRuntime adapter, not a createAgentSdk facade', async () => {
    const source = await readFile(
      new URL('../src/surfaces/runtimeBridgeAdapter.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('this.runtime.stream(this.agent');
    expect(source).toContain('this.runtime.run(this.agent');
    expect(source).not.toContain('createAgentSdk');
    expect(source).not.toMatch(/new\s+AgentRuntime\s*\(/);
  });

  it('routes GUI issue dispatch through durable spawn/checkpoint coordination', async () => {
    const source = await readFile(
      new URL('../src/gui/hadamardGui.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('new DurableIssueCoordinator(');
    expect(source).toContain('new SqliteDurableChildStore(');
    expect(source).toContain('await coordinator.run({');
    expect(source).toContain("prefix: 'gui-issue:'");
  });

  it.each([
    'src/cli/hadamard-react.ts',
    'src/tui/hadamardTui.ts',
    'src/gui/hadamardGui.ts',
  ])('%s mounts and closes the managed plugin runtime', async (file) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).toContain('createManagedPluginRuntime');
    expect(source).toMatch(/managedPluginRuntime(?:Close)?/);
    expect(source).toMatch(/managedPluginRuntime(?:Close)?(?:\(\)|\.close(?:\(\))?)/);
  });

  it.each([
    'src/cli/hadamard-react.ts',
    'src/tui/hadamardTui.ts',
  ])('%s retries managed plugin cleanup and exits nonzero on failure', async (file) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).toContain('closeManagedPluginsForExit');
    expect(source).toContain('MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS = 2');
    expect(source).toContain('billing may continue');
    expect(source).toContain('exitCode = 1');
    expect(source).not.toMatch(/managedPluginRuntime\?*\.close\(\)\.catch\(\(\) => undefined\)/);
  });

  it('keeps React CLI interactive approvals out of the steering queue', async () => {
    const source = await readFile(
      new URL('../src/cli/hadamard-react.ts', import.meta.url),
      'utf8',
    );
    const approvalBranch = source.indexOf('if (pendingToolApproval) {', source.indexOf("rl.on('line'"));
    const steeringBranch = source.indexOf('if (abortCtrl) {', source.indexOf("rl.on('line'"));
    expect(approvalBranch).toBeGreaterThan(0);
    expect(approvalBranch).toBeLessThan(steeringBranch);
    expect(source).toContain("behavior: allowed ? 'allow' : 'deny'");
  });

  it('reports GUI and Electron cleanup failures instead of always exiting successfully', async () => {
    const gui = await readFile(
      new URL('../src/gui/hadamardGui.ts', import.meta.url),
      'utf8',
    );
    const electron = await readFile(
      new URL('../src/gui/electronMain.ts', import.meta.url),
      'utf8',
    );

    expect(gui).toContain('managed plugin cleanup attempt ${attempt}/2 failed');
    expect(gui).toContain("process.exit(1)");
    expect(gui).not.toContain('close().finally(() => process.exit(0))');
    expect(electron).toContain('quittingAfterCleanup');
    expect(electron).toContain("app.exit(1)");
    expect(electron).toContain('dialog.showErrorBox');
    expect(electron).not.toContain('server.close().finally(() => app.quit())');
  });

  it('shows the Electron window after the GUI URL loads even if ready-to-show does not fire', async () => {
    const electron = await readFile(
      new URL('../src/gui/electronMain.ts', import.meta.url),
      'utf8',
    );
    const loadIndex = electron.indexOf('await window.loadURL(guiServer.url);');
    const fallbackIndex = electron.indexOf('if (!window.isVisible()) window.show();');
    expect(loadIndex).toBeGreaterThan(0);
    expect(fallbackIndex).toBeGreaterThan(loadIndex);
    expect(electron).toContain('let mainWindow: BrowserWindow | null = null;');
    expect(electron).toContain('mainWindow = window;');
    expect(electron).toContain('if (mainWindow === window) mainWindow = null;');
    expect(electron).toContain('show: true,');
    expect(electron).not.toContain('show: false,');
  });
});
