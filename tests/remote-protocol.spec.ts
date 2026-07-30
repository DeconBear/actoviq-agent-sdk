import { describe, expect, it } from 'vitest';

import { parseRemoteWorkerMessage } from '../src/index.js';

describe('remote worker protocol', () => {
  it('accepts versioned messages and rejects unknown versions', () => {
    expect(parseRemoteWorkerMessage({
      version: 1,
      type: 'job.lease',
      workerId: 'worker-a',
      leaseMs: 1_000,
    })).toMatchObject({ type: 'job.lease', workerId: 'worker-a' });
    expect(() => parseRemoteWorkerMessage({
      version: 2,
      type: 'job.lease',
      workerId: 'worker-a',
      leaseMs: 1_000,
    })).toThrow('Invalid remote worker protocol envelope');
  });
});
