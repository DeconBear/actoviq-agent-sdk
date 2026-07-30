import { describe, expect, it } from 'vitest';

import { resolveContextRules, type ContextRule } from '../src/index.js';

const rule = (input: Partial<ContextRule> & Pick<ContextRule, 'id' | 'scope' | 'content'>): ContextRule => ({
  enabled: true,
  source: 'test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...input,
});

describe('resolveContextRules', () => {
  it('orders scopes and includes path rules only when touched files match', () => {
    const resolved = resolveContextRules([
      rule({ id: 'path', scope: 'path', pattern: 'src/**/*.ts', content: 'TypeScript rule' }),
      rule({ id: 'project', scope: 'project', content: 'Project rule' }),
      rule({ id: 'user', scope: 'user', content: 'User rule' }),
    ], ['src/runtime/client.ts']);
    expect(resolved.rules.map(item => item.id)).toEqual(['user', 'project', 'path']);
    expect(resolveContextRules([
      rule({ id: 'path', scope: 'path', pattern: 'docs/**', content: 'Docs rule' }),
    ], ['src/index.ts']).rules).toEqual([]);
  });
});
