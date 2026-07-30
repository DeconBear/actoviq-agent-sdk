import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PolicyStore } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PolicyStore', () => {
  it('uses revisions and can roll back to an archived snapshot', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-policy-store-'));
    dirs.push(dir);
    const store = new PolicyStore(path.join(dir, 'policy.json'), 'project');
    const first = await store.save({
      version: 1,
      scope: 'project',
      settings: { mode: 'safe' },
      rules: [],
    }, 0);
    const second = await store.save({
      version: 1,
      scope: 'project',
      settings: { mode: 'fast' },
      rules: [],
    }, first.revision);
    const rolled = await store.rollback(first.revision);
    expect(second.revision).toBe(2);
    expect(rolled.settings).toEqual({ mode: 'safe' });
    expect(rolled.revision).toBe(3);
  });
});
