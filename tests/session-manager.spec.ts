import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../src/index.js';
import { SessionManager } from '../src/runtime/sessionManager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-mgr-'));
  tempDirs.push(dir);
  return new SessionStore(dir);
}

describe('SessionManager', () => {
  it('tracks active sessions via touch', async () => {
    const store = await createStore();
    const manager = new SessionManager(store);

    const session = await store.create({ title: 'Test' });
    await manager.touch(session.id);

    const stats = await manager.getStats();
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });

  it('marks sessions as idle after timeout', async () => {
    const store = await createStore();
    const manager = new SessionManager(store, { idleTimeoutMs: 50 });

    const session = await store.create({ title: 'Test' });
    await manager.touch(session.id);

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 120));

    const updated = await store.load(session.id);
    expect(updated.status).toBe('idle');
  });

  it('closes idle sessions via closeIdle', async () => {
    const store = await createStore();
    const manager = new SessionManager(store, { idleTimeoutMs: 50 });

    const session = await store.create({ title: 'Test' });
    await manager.touch(session.id);

    await new Promise((r) => setTimeout(r, 120));

    const closed = await manager.closeIdle();
    expect(closed).toBeGreaterThanOrEqual(1);

    const updated = await store.load(session.id);
    expect(updated.status).toBe('closed');
  });

  it('prunes closed sessions', async () => {
    const store = await createStore();
    const manager = new SessionManager(store);

    const session = await store.create({ title: 'Test' });
    await store.updateStatus(session.id, 'closed');

    const pruned = await manager.prune({ status: 'closed' });
    expect(pruned).toBeGreaterThanOrEqual(1);

    await expect(store.load(session.id)).rejects.toThrow();
  });

  it('prunes by age with olderThan', async () => {
    const store = await createStore();
    const manager = new SessionManager(store);

    const session = await store.create({ title: 'Old' });
    // Set lastActiveAt far in the past
    await store.updateLastActiveAt(session.id);
    const loaded = await store.load(session.id);
    loaded.lastActiveAt = new Date(Date.now() - 3600 * 1000).toISOString();
    await store.save(loaded);
    await store.updateStatus(session.id, 'idle');

    const pruned = await manager.prune({ olderThan: '30m', status: 'idle' });
    expect(pruned).toBeGreaterThanOrEqual(1);
  });

  it('provides session stats', async () => {
    const store = await createStore();
    const manager = new SessionManager(store);

    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B' });
    await store.updateStatus(b.id, 'idle');

    const stats = await manager.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.idle).toBeGreaterThanOrEqual(1);
  });

  it('dispose stops timers', async () => {
    const store = await createStore();
    const manager = new SessionManager(store, { idleTimeoutMs: 50 });

    const session = await store.create({ title: 'Test' });
    await manager.touch(session.id);

    manager.dispose();

    // Wait past idle timeout, should NOT mark as idle since timers are cleared
    await new Promise((r) => setTimeout(r, 120));

    const updated = await store.load(session.id);
    expect(updated.status).toBe('active');
  });
});
