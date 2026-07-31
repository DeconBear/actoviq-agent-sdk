import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuleStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('RuleStore', () => {
  it('persists rule provenance and enable state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-rules-'));
    dirs.push(dir);
    const store = new RuleStore(path.join(dir, 'rules.json'));
    const added = await store.add({
      scope: 'path',
      pattern: 'src/**',
      content: 'Keep modules small.',
      source: 'user',
    });
    await store.setEnabled(added.id, false);
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: added.id, source: 'user', enabled: false }),
    ]);
    await expect(store.remove(added.id)).resolves.toBe(true);
  });
});
