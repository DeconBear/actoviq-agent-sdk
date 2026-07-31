import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { ThreadDiffService } from '../src/review/threadDiffService.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function repository(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  tempDirs.push(root);
  await execFile('git', ['init', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'file.txt'), 'base\n');
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

describe('ThreadDiffService', () => {
  it('computes structured file hunks and applies them to a clean target', async () => {
    const source = await repository('hadamard-review-source-');
    const base = (await execFile('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(source, 'file.txt'), 'base\nchanged\n');
    const service = new ThreadDiffService();
    const diff = await service.compute({
      sessionId: 'session',
      repoRoot: source,
      worktreePath: source,
      baseCommit: base,
    });
    expect(diff.files).toEqual([
      expect.objectContaining({ path: 'file.txt', additions: 1, status: 'modified' }),
    ]);

    const target = await repository('hadamard-review-target-');
    const applied = await service.apply(diff, target);
    expect(applied).toMatchObject({ applied: true, conflict: false });
    expect((await readFile(path.join(target, 'file.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe(
      'base\nchanged\n',
    );
  });
});
