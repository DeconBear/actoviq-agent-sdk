import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactTransfer } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('ArtifactTransfer', () => {
  it('enforces safe names, size limits, and SHA-256 integrity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-artifact-'));
    dirs.push(dir);
    const transfer = new ArtifactTransfer(dir, 16);
    const content = Buffer.from('verified');
    const sha256 = createHash('sha256').update(content).digest('hex');
    await expect(transfer.receive('result.txt', content, sha256)).resolves.toMatchObject({
      name: 'result.txt',
      size: content.byteLength,
      sha256,
    });
    await expect(transfer.receive('../escape', content, sha256)).rejects.toThrow('Unsafe artifactName');
    await expect(transfer.receive('bad.txt', content, '0'.repeat(64))).rejects.toThrow('SHA-256 mismatch');
    await expect(transfer.receive('large.bin', Buffer.alloc(17), createHash('sha256').update(Buffer.alloc(17)).digest('hex')))
      .rejects.toThrow('byte limit');
  });
});
