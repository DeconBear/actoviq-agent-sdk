import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileCheckpointService } from '../src/checkpoint/fileCheckpointService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('checkpoint restore path conflicts', () => {
  it('rejects a symlink that resolves outside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-checkpoint-symlink-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    const link = path.join(workspace, 'linked');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const target = path.join(link, 'escape.txt');
    await writeFile(target, 'outside');
    const service = new FileCheckpointService({
      storageRoot: path.join(root, 'storage'),
      workspaceRoot: workspace,
    });

    await expect(service.recordChange({
      sessionId: 's',
      turnId: 't',
      filePath: target,
      before: Buffer.from('before'),
      after: Buffer.from('outside'),
    })).rejects.toThrow('outside workspace');
  });
});
