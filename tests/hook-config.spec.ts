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

  it('rejects duplicate ids, invalid matchers, and empty handlers', () => {
    const result = parseTypedHooks([
      { id: 'duplicate', event: 'TurnStart', handler: { type: 'command', command: 'node' } },
      { id: 'duplicate', event: 'TurnEnd', handler: { type: 'prompt', prompt: 'continue?' } },
      { id: 'bad-regex', event: 'PreToolUse', matcher: '[', handler: { type: 'command', command: 'node' } },
      { id: 'empty-command', event: 'TurnStart', handler: { type: 'command', command: ' ' } },
      { id: 'empty-prompt', event: 'TurnStart', handler: { type: 'prompt', prompt: '' } },
      { id: 'empty-url', event: 'TurnStart', handler: { type: 'http', url: '' } },
      { id: 'insecure-url', event: 'TurnStart', handler: { type: 'http', url: 'http://example.com/hook' } },
    ]);

    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.id).toBe('duplicate');
    expect(result.issues).toEqual([
      'typedHooks[1].id duplicates "duplicate".',
      'typedHooks[2].matcher is not a valid regular expression.',
      'typedHooks[3].handler is invalid.',
      'typedHooks[4].handler is invalid.',
      'typedHooks[5].handler is invalid.',
      'typedHooks[6].handler is invalid.',
    ]);
  });
});
