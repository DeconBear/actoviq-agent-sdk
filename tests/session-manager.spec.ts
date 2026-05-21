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

async function waitForSessionStatus(
  store: SessionStore,
  sessionId: string,
  status: string,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: string | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const loaded = await store.load(sessionId);
    lastStatus = loaded.status;
    if (lastStatus === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Session ${sessionId} did not reach ${status}; last status was ${lastStatus ?? 'unknown'}.`);
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

    await waitForSessionStatus(store, session.id, 'idle');
  });

  it('closes idle sessions via closeIdle', async () => {
    const store = await createStore();
    const manager = new SessionManager(store, { idleTimeoutMs: 50 });

    const session = await store.create({ title: 'Test' });
    await manager.touch(session.id);

    await waitForSessionStatus(store, session.id, 'idle');

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

  it('enforces maxSessions by evicting oldest idle/closed sessions', async () => {
    const store = await createStore();
    const manager = new SessionManager(store, { maxSessions: 3 });

    // Create 5 sessions
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await store.create({ title: `Session ${i}` });
      // Set distinct lastActiveAt — oldest first
      s.lastActiveAt = new Date(Date.now() - (5 - i) * 3600_000).toISOString();
      await store.save(s);
      ids.push(s.id);
    }

    // Mark sessions 0-1 as idle, 2-3 as closed, 4 as active
    await store.updateStatus(ids[0]!, 'idle');
    await store.updateStatus(ids[1]!, 'idle');
    await store.updateStatus(ids[2]!, 'closed');
    await store.updateStatus(ids[3]!, 'closed');

    // Touch session 4 (active) — triggers eviction of oldest idle/closed
    await manager.touch(ids[4]!);

    const remaining = await store.list();
    expect(remaining.length).toBeLessThanOrEqual(3);
    // Active session should survive
    expect(remaining.some((s) => s.id === ids[4])).toBe(true);
  });
});
