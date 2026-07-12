import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteStorageV2,
  type DurableStorageV2,
} from '../src/storage-v2/index.js';

const tempDirectories: string[] = [];
const openStores: DurableStorageV2[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  source: string;
  storage: SqliteStorageV2;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-storage-v2-migration-'));
  tempDirectories.push(root);
  const source = path.join(root, 'legacy');
  await mkdir(path.join(source, 'sessions'), { recursive: true });
  const storage = await SqliteStorageV2.open({ filename: path.join(root, 'target.sqlite') });
  openStores.push(storage);
  return { root, source, storage };
}

async function writeLegacySession(
  source: string,
  id: string,
  content = `hello-${id}`,
): Promise<string> {
  const filename = path.join(source, 'sessions', `${id}.json`);
  await writeFile(filename, JSON.stringify({
    version: 1,
    id,
    revision: 7,
    title: `Legacy ${id}`,
    model: 'legacy-model',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    metadata: { migrated: false },
    messages: [{ role: 'user', content, createdAt: '2025-01-01T01:00:00.000Z' }],
    runs: [{ runId: `run-${id}`, text: `answer-${id}` }],
  }, null, 2), 'utf8');
  return filename;
}

describe('JsonV1Migrator', () => {
  it('reports a dry run without creating a backup or writing target sessions', async () => {
    const { root, source, storage } = await fixture();
    await writeLegacySession(source, 'dry-run');
    const backup = path.join(root, 'must-not-exist');

    const report = await storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a',
      sourceDirectory: source,
      backupDirectory: backup,
      dryRun: true,
    });

    expect(report).toMatchObject({
      dryRun: true,
      migratedSessions: 0,
      skippedSessions: 0,
      totalItems: 2,
      files: [{ sessionId: 'dry-run', itemCount: 2, status: 'planned' }],
    });
    await expect(storage.sessions.get({ tenantId: 'tenant-a', sessionId: 'dry-run' }))
      .resolves.toBeUndefined();
    await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('backs up before cutover, imports each item, and is idempotent', async () => {
    const { root, source, storage } = await fixture();
    const sourceFile = await writeLegacySession(source, 'alpha');
    const sourceBefore = await readFile(sourceFile, 'utf8');
    const backup = path.join(root, 'legacy-backup');

    const report = await storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a',
      sourceDirectory: source,
      backupDirectory: backup,
    });
    expect(report).toMatchObject({
      dryRun: false,
      backupDirectory: backup,
      migratedSessions: 1,
      skippedSessions: 0,
      totalItems: 2,
    });
    expect(await readFile(path.join(backup, 'sessions', 'alpha.json'), 'utf8'))
      .toBe(sourceBefore);
    const loaded = await storage.sessions.load({
      tenantId: 'tenant-a',
      sessionId: 'alpha',
      afterSequence: 0,
    });
    expect(loaded.session).toMatchObject({ revision: 1, lastSequence: 2 });
    expect(loaded.session.metadata).toMatchObject({
      sourceFormat: 'actoviq-json-v1',
      legacy: { title: 'Legacy alpha', revision: 7 },
    });
    expect(loaded.items.map((item) => item.kind)).toEqual(['text', 'legacy_run']);

    const repeated = await storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a',
      sourceDirectory: source,
      backupDirectory: backup,
    });
    expect(repeated).toMatchObject({
      migratedSessions: 0,
      skippedSessions: 1,
      files: [{ sessionId: 'alpha', status: 'skipped' }],
    });
    expect(repeated.backupDirectory).toBeUndefined();
    expect((await storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'alpha', afterSequence: 0,
    })).items).toHaveLength(2);
    expect(await readFile(sourceFile, 'utf8')).toBe(sourceBefore);
  });

  it('rolls back all target writes and preserves every source on cutover failure', async () => {
    const { root, source, storage } = await fixture();
    const firstFile = await writeLegacySession(source, 'a-first');
    const conflictFile = await writeLegacySession(source, 'z-conflict');
    const originals = await Promise.all([
      readFile(firstFile, 'utf8'),
      readFile(conflictFile, 'utf8'),
    ]);
    await storage.sessions.create({
      tenantId: 'tenant-a',
      sessionId: 'z-conflict',
      metadata: { owner: 'existing' },
    });
    const backup = path.join(root, 'failure-backup');

    await expect(storage.jsonV1Migration.migrate({
      tenantId: 'tenant-a',
      sourceDirectory: source,
      backupDirectory: backup,
    })).rejects.toMatchObject({
      code: 'STORAGE_CONFLICT',
      expectedRevision: null,
      actualRevision: 0,
    });

    expect(await storage.sessions.get({ tenantId: 'tenant-a', sessionId: 'a-first' }))
      .toBeUndefined();
    expect(await storage.sessions.get({ tenantId: 'tenant-a', sessionId: 'z-conflict' }))
      .toMatchObject({ metadata: { owner: 'existing' }, revision: 0 });
    expect(await readFile(firstFile, 'utf8')).toBe(originals[0]);
    expect(await readFile(conflictFile, 'utf8')).toBe(originals[1]);
    expect(await readFile(path.join(backup, 'sessions', 'a-first.json'), 'utf8'))
      .toBe(originals[0]);
  });
});
