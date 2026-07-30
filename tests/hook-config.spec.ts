import { describe, expect, it } from 'vitest';

import { parseTypedHooks } from '../src/hooks/hookConfig.js';

describe('typed hook config', () => {
  it('validates handlers without discarding other valid hooks', () => {
    const result = parseTypedHooks([
      { id: 'ok', event: 'TurnStart', handler: { type: 'command', command: 'node', args: ['--version'] } },
      { id: 'bad', event: 'Unknown', handler: {} },
    ]);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.id).toBe('ok');
    expect(result.issues).toHaveLength(1);
  });
});
