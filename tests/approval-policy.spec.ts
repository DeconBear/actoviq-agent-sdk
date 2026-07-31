import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalPolicy } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('ApprovalPolicy', () => {
  it('persists path-scoped decisions and ignores expired approvals', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-approval-policy-'));
    dirs.push(dir);
    const policy = new ApprovalPolicy(path.join(dir, 'approvals.json'));
    await policy.remember({
      id: 'write-project',
      tool: 'Write',
      behavior: 'allow',
      pathPrefix: dir,
      createdAt: new Date().toISOString(),
    });
    await policy.remember({
      id: 'expired-bash',
      tool: 'Bash',
      behavior: 'deny',
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    });
    await expect(policy.decide('Write', path.join(dir, 'file.txt'))).resolves.toBe('allow');
    await expect(policy.decide('Write', path.join(path.dirname(dir), 'outside.txt'))).resolves.toBeUndefined();
    await expect(policy.decide('Bash')).resolves.toBeUndefined();
  });
});
