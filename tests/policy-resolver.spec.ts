import { describe, expect, it } from 'vitest';

import { assertPolicyPatchAllowed, resolvePolicy, type PolicyDocument } from '../src/index.js';

const doc = (scope: PolicyDocument['scope'], settings: Record<string, unknown>, lockedSettings?: string[]): PolicyDocument => ({
  version: 1,
  revision: 1,
  scope,
  settings,
  lockedSettings,
  rules: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('policy resolver', () => {
  it('honors authority precedence and locked settings', () => {
    const resolved = resolvePolicy([
      doc('session', { sandbox: { required: false }, model: 'session' }),
      doc('host', { sandbox: { required: true } }, ['sandbox']),
      doc('user', { model: 'user' }),
    ]);
    expect(resolved.settings).toMatchObject({
      sandbox: { required: true },
      model: 'user',
    });
    expect(() => assertPolicyPatchAllowed(resolved, {
      sandbox: { required: false },
    })).toThrow('locked');
  });
});
