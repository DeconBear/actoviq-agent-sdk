import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileCheckpointService } from '../src/checkpoint/fileCheckpointService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(maxFileBytes?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-file-checkpoint-'));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const restoreConversation = vi.fn(async () => undefined);
  const service = new FileCheckpointService({
    storageRoot: path.join(root, 'storage'),
    workspaceRoot,
    maxFileBytes,
    restoreConversation,
  });
  return { root, workspaceRoot, service, restoreConversation };
}

describe('FileCheckpointService', () => {
  it('restores changed and newly-created files together with the conversation locator', async () => {
    const { workspaceRoot, service, restoreConversation } = await fixture();
    const existing = path.join(workspaceRoot, 'src', 'value.txt');
    const created = path.join(workspaceRoot, 'src', 'created.txt');
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, 'before');

    const checkpoint = await service.beginTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      conversationCheckpointId: 'conversation-1',
    });
    await writeFile(existing, 'after');
    await service.recordChange({
      sessionId: 'session-1',
      turnId: 'turn-1',
      filePath: existing,
      before: Buffer.from('before'),
      after: Buffer.from('after'),
    });
    await writeFile(created, 'new');
    await service.recordChange({
      sessionId: 'session-1',
      turnId: 'turn-1',
      filePath: created,
      before: null,
      after: Buffer.from('new'),
    });
    await service.sealTurn('session-1', 'turn-1', 'completed');

    const preview = await service.preview('session-1', checkpoint.id);
    expect(preview.conflicts).toEqual([]);
    expect(preview.files).toEqual([
      expect.objectContaining({ path: path.join('src', 'created.txt'), action: 'delete' }),
      expect.objectContaining({ path: path.join('src', 'value.txt'), action: 'restore' }),
    ]);

    const restored = await service.restore({
      sessionId: 'session-1',
      checkpointId: checkpoint.id,
      mode: 'both',
    });
    expect(restored.conflicts).toEqual([]);
    expect(await readFile(existing, 'utf8')).toBe('before');
    await expect(readFile(created)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restoreConversation).toHaveBeenCalledWith('session-1', 'conversation-1');
  });

  it('refuses to overwrite a file changed after the checkpoint', async () => {
    const { workspaceRoot, service } = await fixture();
    const file = path.join(workspaceRoot, 'value.txt');
    await writeFile(file, 'before');
    const checkpoint = await service.beginTurn({ sessionId: 's', turnId: 't' });
    await writeFile(file, 'after');
    await service.recordChange({
      sessionId: 's',
      turnId: 't',
      filePath: file,
      before: Buffer.from('before'),
      after: Buffer.from('after'),
    });
    await writeFile(file, 'external change');

    const restored = await service.restore({
      sessionId: 's',
      checkpointId: checkpoint.id,
      mode: 'files',
    });
    expect(restored.restoredFiles).toEqual([]);
    expect(restored.conflicts).toEqual([
      expect.objectContaining({ path: 'value.txt', reason: 'modified-after-checkpoint' }),
    ]);
    expect(await readFile(file, 'utf8')).toBe('external change');
  });

  it('retains small binary files and marks oversized changes unrecoverable', async () => {
    const { workspaceRoot, service } = await fixture(4);
    const binary = path.join(workspaceRoot, 'small.bin');
    const large = path.join(workspaceRoot, 'large.bin');
    const checkpoint = await service.beginTurn({ sessionId: 's', turnId: 't' });
    await service.recordChange({
      sessionId: 's',
      turnId: 't',
      filePath: binary,
      before: Buffer.from([0, 1]),
      after: Buffer.from([0, 2]),
    });
    await service.recordChange({
      sessionId: 's',
      turnId: 't',
      filePath: large,
      before: Buffer.from('small'),
      after: Buffer.from('too large'),
    });

    const preview = await service.preview('s', checkpoint.id);
    expect(preview.files).toContainEqual(expect.objectContaining({
      path: 'small.bin',
      binary: true,
      action: 'restore',
    }));
    expect(preview.files).toContainEqual(expect.objectContaining({
      path: 'large.bin',
      action: 'unrecoverable',
    }));
    expect(preview.conflicts).toContainEqual(expect.objectContaining({
      path: 'large.bin',
      reason: 'unrecoverable-entry',
    }));
  });

  it('rejects files outside the workspace root', async () => {
    const { root, service } = await fixture();
    await expect(service.recordChange({
      sessionId: 's',
      turnId: 't',
      filePath: path.join(root, 'outside.txt'),
      before: null,
      after: Buffer.from('x'),
    })).rejects.toThrow('escapes workspace');
  });
});
