import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RemoteJobStore, RemoteWorkerClient } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('remote job lease takeover', () => {
  it('allows another worker to take over only after lease expiry', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-remote-takeover-'));
    dirs.push(dir);
    const store = new RemoteJobStore(dir);
    await new RemoteWorkerClient(store).submit({
      idempotencyKey: 'takeover-job',
      projectPath: process.cwd(),
      prompt: 'recover me',
    });
    const first = await store.lease('worker-a', 5);
    expect(first?.workerId).toBe('worker-a');
    await new Promise(resolve => setTimeout(resolve, 15));
    const second = await store.lease('worker-b', 1_000);
    expect(second?.workerId).toBe('worker-b');
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    await expect(store.complete(
      second!.id,
      'worker-a',
      first!.leaseToken!,
      { text: 'stale' },
    )).rejects.toThrow('lease ownership mismatch');
  });

  it('leases a queued job to only one worker across store instances', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-remote-store-race-'));
    dirs.push(dir);
    const first = new RemoteJobStore(dir);
    const second = new RemoteJobStore(dir);
    await new RemoteWorkerClient(first).submit({
      idempotencyKey: 'race-job',
      projectPath: process.cwd(),
      prompt: 'run once',
    });

    const leases = await Promise.all([
      first.lease('worker-a', 1_000),
      second.lease('worker-b', 1_000),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
  });
});
