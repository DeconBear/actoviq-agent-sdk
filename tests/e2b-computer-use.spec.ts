import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createE2bComputerUseToolkit,
  type E2bDesktopSandboxLike,
} from '../src/computer/e2bComputerUse.js';

function createSandbox(
  kill: E2bDesktopSandboxLike['kill'] = async () => undefined,
): E2bDesktopSandboxLike {
  return {
    sandboxId: 'sandbox-test',
    open: vi.fn(async () => undefined),
    leftClick: vi.fn(async () => undefined),
    doubleClick: vi.fn(async () => undefined),
    rightClick: vi.fn(async () => undefined),
    moveMouse: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    wait: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 })),
    },
    kill,
  };
}

describe('E2B computer-use plugin', () => {
  it('creates one sandbox only after explicit start and reuses it for desktop tools', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'actoviq-e2b-'));
    const outputPath = path.join(temp, 'screen.png');
    const sandbox = createSandbox(vi.fn(async () => undefined));
    const factory = vi.fn(async () => sandbox);
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      template: 'desktop-custom',
      resolution: [1280, 720],
      timeoutMs: 90_000,
      sandboxFactory: factory,
    });

    const names = toolkit.tools.map(item => item.name);
    expect(names).toEqual(expect.arrayContaining([
      'computer_open_url',
      'computer_click',
      'computer_drag',
      'computer_type_text',
      'computer_keypress',
      'computer_take_screenshot',
      'computer_run_command',
      'computer_stop',
    ]));
    expect(factory).not.toHaveBeenCalled();

    const click = toolkit.tools.find(item => item.name === 'computer_click')!;
    await expect(click.execute({ x: 10, y: 20 }, {} as never)).rejects.toThrow(
      /not started.*computer_start/i,
    );
    expect(factory).not.toHaveBeenCalled();

    await toolkit.tools.find(item => item.name === 'computer_start')!
      .execute({}, {} as never);
    await click.execute({ x: 10, y: 20 }, {} as never);
    await toolkit.tools.find(item => item.name === 'computer_take_screenshot')!
      .execute({ outputPath }, { cwd: temp } as never);
    const command = await toolkit.tools.find(item => item.name === 'computer_run_command')!
      .execute({ command: 'pwd', timeoutMs: 5_000 }, {} as never);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      apiKey: 'secret',
      template: 'desktop-custom',
      resolution: [1280, 720],
      timeoutMs: 90_000,
      dpi: undefined,
    });
    expect(sandbox.leftClick).toHaveBeenCalledWith(10, 20);
    expect(await readFile(outputPath)).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(command).toMatchObject({ stdout: 'ok\n', exitCode: 0 });

    await toolkit.close();
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    await rm(temp, { recursive: true, force: true });
  });

  it('rejects every operational tool before explicit start without invoking the factory', async () => {
    const factory = vi.fn(async () => createSandbox());
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      sandboxFactory: factory,
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['computer_open_url', { url: 'https://example.com' }],
      ['computer_click', { x: 1, y: 2 }],
      ['computer_double_click', { x: 1, y: 2 }],
      ['computer_right_click', { x: 1, y: 2 }],
      ['computer_move_mouse', { x: 1, y: 2 }],
      ['computer_drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
      ['computer_scroll', { direction: 'down' }],
      ['computer_type_text', { text: 'hello' }],
      ['computer_keypress', { keys: ['ENTER'] }],
      ['computer_take_screenshot', { outputPath: path.join(os.tmpdir(), 'not-created.png') }],
      ['computer_run_command', { command: 'pwd' }],
      ['computer_wait', { durationMs: 1 }],
    ];

    for (const [toolName, input] of cases) {
      const selected = toolkit.tools.find(item => item.name === toolName)!;
      await expect(selected.execute(input, {} as never)).rejects.toThrow(
        /not started.*computer_start/i,
      );
    }

    await expect(
      toolkit.tools.find(item => item.name === 'computer_stop')!.execute({}, {} as never),
    ).resolves.toEqual({ ok: true });
    expect(factory).not.toHaveBeenCalled();
  });

  it('reports a clear error when the optional E2B desktop package is unavailable', async () => {
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      moduleLoader: async () => {
        throw new Error('module missing');
      },
    });
    const start = toolkit.tools.find(item => item.name === 'computer_start')!;
    await expect(start.execute({}, {} as never)).rejects.toThrow(
      /@e2b\/desktop.*optional dependency/i,
    );
  });

  it('requires an API key before creating a paid sandbox', async () => {
    const toolkit = createE2bComputerUseToolkit({ apiKey: '' });
    const start = toolkit.tools.find(item => item.name === 'computer_start')!;
    await expect(start.execute({}, {} as never)).rejects.toThrow(/E2B API key/i);
  });

  it('returns screenshots in memory or writes only inside the current workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'actoviq-e2b-workspace-'));
    const outside = path.resolve(workspace, '..', `${path.basename(workspace)}-outside.png`);
    const sandbox = createSandbox();
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      sandboxFactory: async () => sandbox,
    });
    const screenshot = toolkit.tools.find(item => item.name === 'computer_take_screenshot')!;

    try {
      expect(screenshot.isReadOnly?.({})).toBe(true);
      expect(screenshot.isDestructive?.({})).toBe(false);
      expect(screenshot.isReadOnly?.({ outputPath: 'screen.png' })).toBe(false);
      expect(screenshot.isDestructive?.({ outputPath: 'screen.png' })).toBe(true);

      await toolkit.tools.find(item => item.name === 'computer_start')!
        .execute({}, {} as never);
      await expect(screenshot.execute({}, { cwd: workspace } as never)).resolves.toEqual({
        base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
        mimeType: 'image/png',
        sizeBytes: 4,
      });

      const result = await screenshot.execute(
        { outputPath: 'screen.png' },
        { cwd: workspace } as never,
      );
      expect(result).toMatchObject({
        savedTo: path.join(workspace, 'screen.png'),
        sizeBytes: 4,
      });
      expect(await readFile(path.join(workspace, 'screen.png')))
        .toEqual(Buffer.from([137, 80, 78, 71]));

      await expect(
        screenshot.execute({ outputPath: '../outside.png' }, { cwd: workspace } as never),
      ).rejects.toThrow(/inside the workspace/i);
      await expect(
        screenshot.execute({ outputPath: outside }, { cwd: workspace } as never),
      ).rejects.toThrow(/inside the workspace/i);
    } finally {
      await toolkit.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('retains the sandbox handle when cleanup retries fail and succeeds on a later retry', async () => {
    const kill = vi.fn(async () => {
      if (kill.mock.calls.length <= 3) throw new Error('temporary kill failure');
    });
    const sandbox = createSandbox(kill);
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      sandboxFactory: async () => sandbox,
    });
    await toolkit.tools.find(item => item.name === 'computer_start')!
      .execute({}, {} as never);

    await expect(toolkit.close()).rejects.toThrow(/handle was retained.*billing may continue/i);
    expect(kill).toHaveBeenCalledTimes(3);
    expect(toolkit.isStarted()).toBe(true);

    await expect(toolkit.close()).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledTimes(4);
    expect(toolkit.isStarted()).toBe(false);
  });

  it('bounds hanging cleanup attempts, aborts them, and preserves the handle for retry', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(
        async (_options?: { requestTimeoutMs?: number; signal?: AbortSignal }) =>
          new Promise<void>(() => undefined),
      );
      const sandbox = createSandbox(kill);
      const toolkit = createE2bComputerUseToolkit({
        apiKey: 'secret',
        sandboxFactory: async () => sandbox,
      });
      await toolkit.tools.find(item => item.name === 'computer_start')!
        .execute({}, {} as never);

      const close = toolkit.close();
      const rejection = expect(close).rejects.toThrow(
        /after 3 attempts.*handle was retained.*billing may continue/i,
      );
      await vi.advanceTimersByTimeAsync(40_000);
      await rejection;

      expect(kill).toHaveBeenCalledTimes(3);
      expect(kill.mock.calls.every(call => call[0]?.requestTimeoutMs === 10_000)).toBe(true);
      expect(kill.mock.calls.every(call => call[0]?.signal?.aborted === true)).toBe(true);
      expect(toolkit.isStarted()).toBe(true);

      kill.mockResolvedValueOnce(undefined);
      await expect(toolkit.close()).resolves.toBeUndefined();
      expect(toolkit.isStarted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('interrupts blocked sandbox commands and waits when the agent run is aborted', async () => {
    const sandbox = createSandbox();
    sandbox.commands.run = vi.fn(
      async () => new Promise<never>(() => undefined),
    );
    sandbox.wait = vi.fn(async () => new Promise<void>(() => undefined));
    const toolkit = createE2bComputerUseToolkit({
      apiKey: 'secret',
      sandboxFactory: async () => sandbox,
    });
    await toolkit.tools.find(item => item.name === 'computer_start')!
      .execute({}, {} as never);

    try {
      for (const [toolName, input] of [
        ['computer_run_command', { command: 'sleep forever' }],
        ['computer_wait', { durationMs: 60_000 }],
      ] as const) {
        const controller = new AbortController();
        const invocation = toolkit.tools.find(item => item.name === toolName)!
          .execute(input, { signal: controller.signal } as never);
        await Promise.resolve();
        controller.abort(new Error(`${toolName} interrupted`));
        await expect(invocation).rejects.toThrow(new RegExp(`${toolName} interrupted`, 'i'));
      }
    } finally {
      await toolkit.close();
    }
  });
});
