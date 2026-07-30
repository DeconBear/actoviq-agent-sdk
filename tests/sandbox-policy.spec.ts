import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSandboxPolicy } from '../src/sandbox/policyResolver.js';

describe('sandbox policy resolver', () => {
  it('only tightens roots, network access, limits, and disable authority', () => {
    const root = path.resolve('workspace');
    const src = path.join(root, 'src');
    const policy = resolveSandboxPolicy(
      root,
      {
        enforcement: 'required',
        readRoots: [root],
        writableRoots: [root],
        network: { mode: 'allowlist', allowedDomains: ['example.com', 'api.example.com'] },
        process: { timeoutMs: 10_000, maxProcesses: 8 },
        allowUserDisable: false,
        source: 'host',
      },
      {
        enforcement: 'off',
        readRoots: [src],
        writableRoots: [src],
        network: { mode: 'allowlist', allowedDomains: ['api.example.com', 'other.test'] },
        process: { timeoutMs: 20_000, maxProcesses: 20 },
        allowUserDisable: true,
        source: 'session',
      },
    );

    expect(policy).toMatchObject({
      enforcement: 'required',
      readRoots: [src],
      writableRoots: [src],
      network: { mode: 'allowlist', allowedDomains: ['api.example.com'] },
      process: { timeoutMs: 10_000, maxProcesses: 8 },
      allowUserDisable: false,
      source: 'session',
    });
  });
});
