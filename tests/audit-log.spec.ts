import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('AuditLog', () => {
  it('redacts nested secrets before durable append', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-audit-'));
    dirs.push(dir);
    const log = new AuditLog(path.join(dir, 'audit.ndjson'));
    await log.append({
      id: 'event-1',
      type: 'policy.changed',
      actor: 'user',
      occurredAt: new Date().toISOString(),
      data: { apiKey: 'secret-value', nested: { authorization: 'Bearer token' } },
    });
    expect((await log.list())[0]?.data).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
    });
  });
});
