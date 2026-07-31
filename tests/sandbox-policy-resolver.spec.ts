import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSandboxPolicy } from '../src/sandbox/policyResolver.js';

describe('sandbox policy resolver', () => {
  it('allows explicit enforcement off while allowUserDisable remains true', () => {
    const root = path.join(os.tmpdir(), 'hadamard-sandbox-policy-off');
    const resolved = resolveSandboxPolicy(root, {
      enforcement: 'off',
      process: { timeoutMs: 250 },
    });
    expect(resolved.enforcement).toBe('off');
    expect(resolved.allowUserDisable).toBe(true);
    expect(resolved.process.timeoutMs).toBe(250);
  });

  it('does not clear allowUserDisable when a partial overlay omits the flag', () => {
    const root = path.join(os.tmpdir(), 'hadamard-sandbox-policy-partial');
    const resolved = resolveSandboxPolicy(root, {
      process: { timeoutMs: 100 },
    });
    expect(resolved.allowUserDisable).toBe(true);
    expect(resolved.enforcement).toBe('best-effort');
  });

  it('refuses to weaken enforcement after allowUserDisable is locked false', () => {
    const root = path.join(os.tmpdir(), 'hadamard-sandbox-policy-locked');
    const resolved = resolveSandboxPolicy(
      root,
      { allowUserDisable: false, enforcement: 'required' },
      { enforcement: 'off' },
    );
    expect(resolved.enforcement).toBe('required');
    expect(resolved.allowUserDisable).toBe(false);
  });
});
