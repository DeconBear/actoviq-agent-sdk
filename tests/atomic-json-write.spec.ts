import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonAtomic } from '../src/storage/atomicJsonWrite.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeJsonAtomic', () => {
  it('persists JSON atomically under concurrent writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'atomic-json-'));
    tempDirs.push(dir);
    const target = path.join(dir, 'shared.json');
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => writeJsonAtomic(target, { i })),
    );
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as { i: number };
    expect(typeof parsed.i).toBe('number');
  });
});
