import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSandboxPolicy } from '../src/sandbox/policyResolver.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('sandbox path validation', () => {
  it('blocks lexical and symlink escapes from writable roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sandbox-path-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    const executor = new SandboxExecutor(resolveSandboxPolicy(workspace));

    await expect(executor.assertPathAllowed(path.join(root, 'escape.txt'), 'write'))
      .rejects.toThrow('outside allowed roots');

    const link = path.join(workspace, 'link');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await expect(executor.assertPathAllowed(path.join(link, 'escape.txt'), 'write'))
      .rejects.toThrow('resolves outside allowed roots');
  });

  it('does not bind the whole host filesystem for linux bubblewrap profiles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sandbox-bwrap-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const executor = new SandboxExecutor({
      ...resolveSandboxPolicy(workspace),
      enforcement: 'best-effort',
    });
    // Reach into the private builder via a typed probe when the adapter is
    // linux; on other platforms just assert readRoots validation still holds.
    const probe = executor as unknown as {
      wrapInvocation: (request: {
        executable: string;
        args: string[];
        cwd: string;
        timeoutMs: number;
      }) => { executable: string; args: string[] };
      capability: { adapter: string };
    };
    if (probe.capability.adapter !== 'linux-bubblewrap') {
      await expect(executor.assertPathAllowed(path.join(root, 'outside.txt'), 'read'))
        .rejects.toThrow('outside allowed roots');
      return;
    }
    const invocation = probe.wrapInvocation({
      executable: '/bin/echo',
      args: ['hi'],
      cwd: workspace,
      timeoutMs: 1_000,
    });
    expect(invocation.executable).toBe('bwrap');
    expect(invocation.args).toContain('--tmpfs');
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--ro-bind', '/', '/']));
    expect(invocation.args).toEqual(expect.arrayContaining(['--bind', workspace, workspace]));
  });
});
