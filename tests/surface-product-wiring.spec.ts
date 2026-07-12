import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCT_SURFACES = [
  ['src/cli/actoviq-react.ts', 'cli'],
  ['src/tui/actoviqTui.ts', 'tui'],
  ['src/gui/actoviqGui.ts', 'gui'],
  ['src/parity/actoviqCleanBridgeCompatSdk.ts', 'bridge'],
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
      new URL('../src/gui/actoviqGui.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('new DurableIssueCoordinator(');
    expect(source).toContain('new SqliteDurableChildStore(');
    expect(source).toContain('await coordinator.run({');
    expect(source).toContain("prefix: 'gui-issue:'");
  });
});
