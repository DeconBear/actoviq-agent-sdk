import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  nodeSqliteDriverFactory,
  SqliteStorageV2,
  StorageConflictError,
  type DurableStorageV2,
  type SqliteDriver,
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

async function createStorage(filename = 'storage.sqlite'): Promise<SqliteStorageV2> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-storage-v2-'));
  tempDirectories.push(root);
  const storage = await SqliteStorageV2.open({ filename: path.join(root, filename) });
  openStores.push(storage);
  return storage;
}

async function createInstrumentedStorage(
  beforeRun: (sql: string) => void = () => undefined,
): Promise<{ storage: SqliteStorageV2; rawDriver: SqliteDriver }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-storage-v2-instrumented-'));
  tempDirectories.push(root);
  let rawDriver!: SqliteDriver;
  const storage = await SqliteStorageV2.open({
    filename: path.join(root, 'storage.sqlite'),
    driverFactory: {
      async open(filename) {
        rawDriver = await nodeSqliteDriverFactory.open(filename);
        return {
          exec: sql => rawDriver.exec(sql),
          prepare: sql => {
            const statement = rawDriver.prepare(sql);
            return {
              run: (...parameters) => {
                beforeRun(sql);
                return statement.run(...parameters);
              },
              get: (...parameters) => statement.get(...parameters),
              all: (...parameters) => statement.all(...parameters),
            };
          },
          transaction: operation => rawDriver.transaction(operation),
          close: () => rawDriver.close(),
        };
      },
    },
  });
  openStores.push(storage);
  return { storage, rawDriver };
}

describe('SqliteSessionStore', () => {
  it('uses CAS, appends immutable log items, and loads from a compacted snapshot', async () => {
    const storage = await createStorage();
    const created = await storage.sessions.create({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      metadata: { agent: 'researcher' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(created).toMatchObject({ revision: 0, lastSequence: 0 });

    const appended = await storage.sessions.append({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      expectedRevision: 0,
      items: [
        { itemId: 'item-1', kind: 'message', payload: { text: 'one' } },
        { itemId: 'item-2', kind: 'message', payload: { text: 'two' } },
      ],
    });
    expect(appended).toMatchObject({ revision: 1, lastSequence: 2 });
    await expect(storage.sessions.append({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      expectedRevision: 0,
      items: [{ itemId: 'stale', kind: 'message', payload: { text: 'lost' } }],
    })).rejects.toMatchObject({
      code: 'STORAGE_CONFLICT',
      expectedRevision: 0,
      actualRevision: 1,
    } satisfies Partial<StorageConflictError>);

    const snapshot = await storage.sessions.compact({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      expectedRevision: 1,
      throughSequence: 1,
      state: { messages: [{ text: 'one' }] },
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    expect(snapshot).toMatchObject({ throughSequence: 1, revision: 2 });
    await storage.sessions.append({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      expectedRevision: 2,
      items: [{ itemId: 'item-3', kind: 'tool-result', payload: { ok: true } }],
    });

    const compacted = await storage.sessions.load({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
    });
    expect(compacted.snapshot).toEqual(snapshot);
    expect(compacted.items.map((item) => item.itemId)).toEqual(['item-2', 'item-3']);

    // Compaction changes the read base but preserves the append-only history.
    const history = await storage.sessions.load({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      afterSequence: 0,
    });
    expect(history.snapshot).toBeUndefined();
    expect(history.items.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(history.items[0]?.payload).toEqual({ text: 'one' });
  });

  it('allows exactly one cross-connection writer for the same revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-storage-v2-shared-'));
    tempDirectories.push(root);
    const filename = path.join(root, 'shared.sqlite');
    const first = await SqliteStorageV2.open({ filename });
    const second = await SqliteStorageV2.open({ filename });
    openStores.push(first, second);
    await first.sessions.create({ tenantId: 'tenant-a', sessionId: 'shared' });

    const results = await Promise.allSettled([
      first.sessions.append({
        tenantId: 'tenant-a',
        sessionId: 'shared',
        expectedRevision: 0,
        items: [{ itemId: 'left', kind: 'message', payload: 'left' }],
      }),
      second.sessions.append({
        tenantId: 'tenant-a',
        sessionId: 'shared',
        expectedRevision: 0,
        items: [{ itemId: 'right', kind: 'message', payload: 'right' }],
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.sessions.load({
      tenantId: 'tenant-a',
      sessionId: 'shared',
      afterSequence: 0,
    })).items).toHaveLength(1);
  });

  it('rolls back a partially written append when SQLite reports ENOSPC', async () => {
    let failItemInsert = false;
    let itemInsertCalls = 0;
    const { storage } = await createInstrumentedStorage((sql) => {
      if (!failItemInsert || !sql.includes('INSERT INTO storage_v2_session_items')) return;
      itemInsertCalls += 1;
      if (itemInsertCalls === 2) {
        throw Object.assign(new Error('database or disk is full'), { code: 'ENOSPC' });
      }
    });
    await storage.sessions.create({ tenantId: 'tenant-a', sessionId: 'disk-full' });
    failItemInsert = true;

    const append = {
      tenantId: 'tenant-a',
      sessionId: 'disk-full',
      expectedRevision: 0,
      items: [
        { itemId: 'first', kind: 'message', payload: 'first' },
        { itemId: 'second', kind: 'message', payload: 'second' },
      ],
    } as const;
    await expect(storage.sessions.append(append)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'disk-full', afterSequence: 0,
    })).toMatchObject({ session: { revision: 0, lastSequence: 0 }, items: [] });

    failItemInsert = false;
    await expect(storage.sessions.append(append)).resolves.toMatchObject({
      revision: 1,
      lastSequence: 2,
    });
  });

  it('fails closed when a persisted session snapshot contains corrupt JSON', async () => {
    const { storage, rawDriver } = await createInstrumentedStorage();
    await storage.sessions.create({ tenantId: 'tenant-a', sessionId: 'corrupt-snapshot' });
    await storage.sessions.append({
      tenantId: 'tenant-a',
      sessionId: 'corrupt-snapshot',
      expectedRevision: 0,
      items: [{ itemId: 'one', kind: 'message', payload: 'one' }],
    });
    rawDriver.prepare(`
      INSERT INTO storage_v2_session_snapshots (
        tenant_id, session_id, through_sequence,
        session_revision, state_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'tenant-a',
      'corrupt-snapshot',
      1,
      1,
      '{not-json',
      '2026-01-01T00:00:00.000Z',
    );

    await expect(storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'corrupt-snapshot',
    })).rejects.toMatchObject({ code: 'STORAGE_DATA_INVALID' });
  });
});

describe('SqliteCheckpointStore', () => {
  it('round-trips resumable interruption, pending side-effect, and trace state exactly', async () => {
    const storage = await createStorage();
    const saved = await storage.checkpoints.save({
      tenantId: 'tenant-a',
      checkpointId: 'checkpoint-1',
      runId: 'run-1',
      sessionId: 'session-1',
      expectedRevision: null,
      status: 'awaiting_side_effect',
      state: {
        turn: 4,
        canonicalItems: [{ type: 'tool_call', id: 'call-1' }],
      },
      interruption: {
        reason: 'human_approval',
        resumable: true,
        requestedAt: '2026-02-01T00:00:00.000Z',
        details: { prompt: 'Approve deployment?' },
      },
      pendingSideEffects: [{
        sideEffectId: 'effect-1',
        kind: 'tool:deploy',
        status: 'started',
        idempotencyKey: 'deploy-42',
        input: { environment: 'staging' },
      }],
      traceContext: {
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        traceState: 'vendor=value',
        baggage: { tenant: 'tenant-a' },
      },
      updatedAt: '2026-02-01T00:00:01.000Z',
    });

    expect(saved.revision).toBe(0);
    expect(await storage.checkpoints.load({
      tenantId: 'tenant-a',
      checkpointId: 'checkpoint-1',
    })).toEqual(saved);

    const resumed = await storage.checkpoints.save({
      tenantId: 'tenant-a',
      checkpointId: 'checkpoint-1',
      runId: 'run-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      status: 'running',
      state: { turn: 5, canonicalItems: [] },
      pendingSideEffects: [{
        sideEffectId: 'effect-1',
        kind: 'tool:deploy',
        status: 'unknown',
        idempotencyKey: 'deploy-42',
      }],
      traceContext: saved.traceContext,
    });
    expect(resumed).toMatchObject({ revision: 1, status: 'running' });
    expect(resumed.interruption).toBeUndefined();
    expect(resumed.pendingSideEffects[0]?.status).toBe('unknown');

    await expect(storage.checkpoints.save({
      tenantId: 'tenant-a',
      checkpointId: 'checkpoint-1',
      runId: 'run-1',
      expectedRevision: 0,
      status: 'completed',
      state: {},
      traceContext: saved.traceContext,
    })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT', actualRevision: 1 });
  });
});

describe('storage-v2 tenant namespaces', () => {
  it('isolates sessions, checkpoints, memory, and artifacts with identical ids', async () => {
    const storage = await createStorage();
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      await storage.sessions.create({ tenantId, sessionId: 'same' });
      await storage.sessions.append({
        tenantId,
        sessionId: 'same',
        expectedRevision: 0,
        items: [{ itemId: 'same', kind: 'message', payload: tenantId }],
      });
      await storage.checkpoints.save({
        tenantId,
        checkpointId: 'same',
        runId: `run-${tenantId}`,
        expectedRevision: null,
        status: 'running',
        state: { tenantId },
        traceContext: { traceId: `trace-${tenantId}`, spanId: 'span' },
      });
      await storage.memory.put({
        tenantId,
        memoryId: 'same',
        namespace: 'profile',
        expectedRevision: null,
        value: { tenantId },
      });
      await storage.artifacts.put({
        tenantId,
        artifactId: 'same',
        expectedRevision: null,
        mediaType: 'text/plain',
        data: new TextEncoder().encode(tenantId),
      });
    }

    expect((await storage.sessions.load({
      tenantId: 'tenant-a', sessionId: 'same', afterSequence: 0,
    })).items[0]?.payload).toBe('tenant-a');
    expect((await storage.sessions.load({
      tenantId: 'tenant-b', sessionId: 'same', afterSequence: 0,
    })).items[0]?.payload).toBe('tenant-b');
    expect((await storage.checkpoints.load({
      tenantId: 'tenant-a', checkpointId: 'same',
    }))?.runId).toBe('run-tenant-a');
    expect((await storage.memory.list({ tenantId: 'tenant-a' })).map((item) => item.tenantId))
      .toEqual(['tenant-a']);
    expect((await storage.artifacts.list({ tenantId: 'tenant-b' })).map((item) => item.tenantId))
      .toEqual(['tenant-b']);
    expect(new TextDecoder().decode((await storage.artifacts.get({
      tenantId: 'tenant-b', artifactId: 'same',
    }))?.data)).toBe('tenant-b');
  });

  it('applies CAS to memory and artifacts while keeping artifact bytes out of list results', async () => {
    const storage = await createStorage();
    const memory = await storage.memory.put({
      tenantId: 'tenant-a', memoryId: 'm1', namespace: 'facts',
      expectedRevision: null, value: { answer: 42 },
    });
    const artifact = await storage.artifacts.put({
      tenantId: 'tenant-a', artifactId: 'a1', expectedRevision: null,
      mediaType: 'application/octet-stream', data: Uint8Array.of(0, 1, 2),
    });

    expect(memory.revision).toBe(0);
    expect(artifact).toMatchObject({ revision: 0, size: 3 });
    expect(Array.from(artifact.data)).toEqual([0, 1, 2]);
    expect(await storage.artifacts.list({ tenantId: 'tenant-a' })).toEqual([
      expect.not.objectContaining({ data: expect.anything() }),
    ]);
    await expect(storage.memory.put({
      tenantId: 'tenant-a', memoryId: 'm1', namespace: 'facts',
      expectedRevision: null, value: { answer: 0 },
    })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT', actualRevision: 0 });
    await expect(storage.artifacts.put({
      tenantId: 'tenant-a', artifactId: 'a1', expectedRevision: 1,
      mediaType: 'text/plain', data: Uint8Array.of(9),
    })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT', actualRevision: 0 });
  });
});
