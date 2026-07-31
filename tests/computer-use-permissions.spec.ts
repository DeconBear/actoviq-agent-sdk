import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createHadamardComputerUseTools } from '../src/computer/hadamardComputerUse.js';
import { decideHadamardToolPermission } from '../src/runtime/hadamardPermissions.js';

function tools() {
  return createHadamardComputerUseTools({
    executor: {
      openUrl: vi.fn(),
      focusWindow: vi.fn(),
      typeText: vi.fn(),
      keyPress: vi.fn(),
      readClipboard: vi.fn(() => ''),
      writeClipboard: vi.fn(),
      takeScreenshot: vi.fn((outputPath: string) => outputPath),
    },
  });
}

describe('local computer-use permission metadata', () => {
  it('classifies each host action accurately', () => {
    const byName = new Map(tools().map(tool => [tool.name, tool]));
    const hostMutations = [
      'computer_open_url',
      'computer_focus_window',
      'computer_type_text',
      'computer_keypress',
      'computer_write_clipboard',
      'computer_take_screenshot',
    ];
    for (const name of hostMutations) {
      const definition = byName.get(name)!;
      expect(definition.isReadOnly?.({}), name).toBe(false);
      expect(definition.isDestructive?.({}), name).toBe(true);
      expect(definition.requiresUserInteraction?.(), name).toBe(true);
    }

    const readClipboard = byName.get('computer_read_clipboard')!;
    expect(readClipboard.isReadOnly?.({})).toBe(true);
    expect(readClipboard.isDestructive?.({})).toBe(false);
    expect(readClipboard.requiresUserInteraction?.()).toBe(true);

    const wait = byName.get('computer_wait')!;
    expect(wait.isReadOnly?.({ durationMs: 1 })).toBe(true);
    expect(wait.isDestructive?.({ durationMs: 1 })).toBe(false);
    expect(wait.requiresUserInteraction?.()).toBe(false);
  });

  it('classifies workflows from their steps and fails closed without input', () => {
    const workflow = tools().find(tool => tool.name === 'computer_run_workflow')!;
    const passive = {
      steps: [
        { action: 'read_clipboard' },
        { action: 'wait', durationMs: 1 },
      ],
    };
    const mutating = {
      steps: [
        { action: 'focus_window', title: 'Terminal' },
        { action: 'type_text', text: 'hello' },
      ],
    };

    expect(workflow.isReadOnly?.(passive)).toBe(true);
    expect(workflow.isDestructive?.(passive)).toBe(false);
    expect(workflow.isReadOnly?.(mutating)).toBe(false);
    expect(workflow.isDestructive?.(mutating)).toBe(true);
    expect(workflow.isReadOnly?.()).toBe(false);
    expect(workflow.isDestructive?.()).toBe(true);
    expect(workflow.requiresUserInteraction?.()).toBe(true);
  });

  it('does not auto-allow typing or workflows in bypass mode', async () => {
    const byName = new Map(tools().map(tool => [tool.name, tool]));
    for (const [name, input] of [
      ['computer_type_text', { text: 'dangerous command' }],
      ['computer_run_workflow', {
        steps: [{ action: 'focus_window', title: 'Terminal' }],
      }],
    ] as const) {
      const definition = byName.get(name)!;
      const approver = vi.fn(async () => ({
        behavior: 'allow' as const,
        reason: 'approved',
      }));
      const decision = await decideHadamardToolPermission({
        mode: 'bypassPermissions',
        rules: [],
        approver,
        adapter: definition,
        runId: 'run-1',
        workDir: process.cwd(),
        toolName: name,
        publicName: name,
        prompt: 'control the host',
        toolInput: input,
        iteration: 1,
      });

      expect(approver, name).toHaveBeenCalledOnce();
      expect(decision.behavior, name).toBe('allow');
      expect(decision.reason, name).toBe('approved');
    }
  });

  it('keeps direct and workflow screenshot output inside the active workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'hadamard-local-computer-'));
    const takeScreenshot = vi.fn((outputPath: string) => outputPath);
    const definitions = createHadamardComputerUseTools({
      executor: {
        openUrl: vi.fn(),
        focusWindow: vi.fn(),
        typeText: vi.fn(),
        keyPress: vi.fn(),
        readClipboard: vi.fn(() => ''),
        writeClipboard: vi.fn(),
        takeScreenshot,
      },
    });
    const screenshot = definitions.find(tool => tool.name === 'computer_take_screenshot')!;
    const workflow = definitions.find(tool => tool.name === 'computer_run_workflow')!;

    try {
      await expect(
        screenshot.execute({ outputPath: '../outside.png' }, { cwd: workspace } as never),
      ).rejects.toThrow(/inside the workspace/i);
      await expect(
        screenshot.execute({ outputPath: path.join(os.tmpdir(), 'outside.png') }, {
          cwd: workspace,
        } as never),
      ).rejects.toThrow(/inside the workspace/i);
      await expect(
        workflow.execute({
          steps: [{ action: 'take_screenshot', outputPath: '../outside.png' }],
        }, { cwd: workspace } as never),
      ).rejects.toThrow(/inside the workspace/i);

      await expect(
        screenshot.execute({ outputPath: 'screen.png' }, { cwd: workspace } as never),
      ).resolves.toEqual({
        savedTo: path.join(realpathSync.native(workspace), 'screen.png'),
      });
      expect(takeScreenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('interrupts waits and blocked workflow steps without starting later steps', async () => {
    const blocked = new Promise<void>(() => undefined);
    const openUrl = vi.fn(() => blocked);
    const typeText = vi.fn(async () => undefined);
    const definitions = createHadamardComputerUseTools({
      executor: {
        openUrl,
        typeText,
        keyPress: vi.fn(),
        readClipboard: vi.fn(() => ''),
        writeClipboard: vi.fn(),
        takeScreenshot: vi.fn((outputPath: string) => outputPath),
      },
    });
    const wait = definitions.find(tool => tool.name === 'computer_wait')!;
    const workflow = definitions.find(tool => tool.name === 'computer_run_workflow')!;

    const waitController = new AbortController();
    const waiting = wait.execute(
      { durationMs: 60_000 },
      { signal: waitController.signal } as never,
    );
    waitController.abort(new Error('wait interrupted'));
    await expect(waiting).rejects.toThrow(/wait interrupted/i);

    const workflowController = new AbortController();
    const running = workflow.execute({
      steps: [
        { action: 'open_url', url: 'https://example.com' },
        { action: 'type_text', text: 'must not run' },
      ],
    }, {
      cwd: process.cwd(),
      signal: workflowController.signal,
    } as never);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());
    workflowController.abort(new Error('workflow interrupted'));

    await expect(running).rejects.toThrow(/workflow interrupted/i);
    expect(typeText).not.toHaveBeenCalled();
  });

  it('forwards AbortSignal into executor actions so backends can cancel host work', async () => {
    const openUrl = vi.fn((_url: string, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('host action aborted'),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }));
    const definitions = createHadamardComputerUseTools({
      executor: {
        openUrl,
        typeText: vi.fn(),
        keyPress: vi.fn(),
        readClipboard: vi.fn(() => ''),
        writeClipboard: vi.fn(),
        takeScreenshot: vi.fn((outputPath: string) => outputPath),
      },
    });
    const open = definitions.find(tool => tool.name === 'computer_open_url')!;
    const controller = new AbortController();
    const pending = open.execute(
      { url: 'https://example.com' },
      { signal: controller.signal } as never,
    );
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());
    expect(openUrl.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort(new Error('host aborted'));
    await expect(pending).rejects.toThrow(/host aborted/i);
  });

  it('caps a single local computer workflow at 50 steps', async () => {
    const workflow = tools().find(tool => tool.name === 'computer_run_workflow')!;
    const steps = Array.from({ length: 51 }, () => ({
      action: 'wait' as const,
      durationMs: 1,
    }));

    await expect(
      workflow.inputSchema.parseAsync({ steps }),
    ).rejects.toThrow();
  });
});
