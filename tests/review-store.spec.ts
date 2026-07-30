import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ReviewStore } from '../src/review/reviewStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('ReviewStore', () => {
  it('persists line comments and resolution revisions atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-review-store-'));
    tempDirs.push(root);
    const store = new ReviewStore(root);
    const added = await store.addComment('session', {
      filePath: 'src/a.ts',
      line: 4,
      side: 'new',
      body: 'Please handle the error.',
    });
    expect(added.revision).toBe(1);
    expect(added.comments[0]).toMatchObject({ resolved: false, line: 4 });
    const resolved = await store.resolveComment('session', added.comments[0]!.id);
    expect(resolved).toMatchObject({ revision: 2 });
    expect(resolved.comments[0]?.resolved).toBe(true);
  });
});
