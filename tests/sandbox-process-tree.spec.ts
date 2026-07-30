import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSandboxPolicy } from '../src/sandbox/policyResolver.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('sandbox process lifecycle', () => {
  it('terminates a process tree at the configured timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sandbox-process-'));
    tempDirs.push(root);
    await mkdir(root, { recursive: true });
    // Isolation is orthogonal: this assertion covers process-tree kill + the
    // policy timeout clamp. Keep enforcement off so a degraded FS profile
    // cannot exit the child before the timer fires (macOS seatbelt edge cases).
    const executor = new SandboxExecutor(resolveSandboxPolicy(root, {
      enforcement: 'off',
      process: { timeoutMs: 250 },
    }));
    const started = Date.now();
    const result = await executor.execute({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.capability.processTreeTermination).toBe(true);
  });

  it('never claims a required sandbox when the platform adapter is degraded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sandbox-required-'));
    tempDirs.push(root);
    const executor = new SandboxExecutor(resolveSandboxPolicy(root, {
      enforcement: 'required',
    }));
    if (!executor.capability.degraded) return;
    await expect(executor.execute({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x")'],
      cwd: root,
      timeoutMs: 2_000,
    })).rejects.toThrow('Required sandbox is unavailable');
  });
});
