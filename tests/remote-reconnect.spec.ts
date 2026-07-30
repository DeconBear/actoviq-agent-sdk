import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RemoteJobStore, RemoteWorkerClient } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('RemoteWorkerClient reconnect', () => {
  it('reuses an idempotent durable job across client instances', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-remote-reconnect-'));
    dirs.push(dir);
    const first = new RemoteWorkerClient(new RemoteJobStore(dir));
    const submitted = await first.submit({
      idempotencyKey: 'stable-job',
      projectPath: process.cwd(),
      prompt: 'continue after reconnect',
    });
    const second = new RemoteWorkerClient(new RemoteJobStore(dir));
    const replayed = await second.submit({
      idempotencyKey: 'stable-job',
      projectPath: process.cwd(),
      prompt: 'continue after reconnect',
    });

    expect(replayed.id).toBe(submitted.id);
    expect((await second.get(submitted.id)).status).toBe('queued');
  });
});
