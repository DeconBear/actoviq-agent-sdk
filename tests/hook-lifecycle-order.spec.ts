import { describe, expect, it } from 'vitest';

import { HookRunner } from '../src/hooks/hookRunner.js';
import { createPromptHookHandler } from '../src/hooks/handlers/promptHook.js';

describe('typed hook lifecycle order', () => {
  it('preserves declared order for one lifecycle event', async () => {
    const seen: string[] = [];
    const runner = new HookRunner({
      hooks: ['a', 'b', 'c'].map(id => ({
        id,
        event: 'TurnEnd' as const,
        handler: { type: 'prompt' as const, prompt: id },
      })),
      promptHandler: createPromptHookHandler(async prompt => {
        seen.push(prompt);
        return {};
      }),
    });
    await runner.run({
      event: 'TurnEnd',
      runId: 'run',
      cwd: process.cwd(),
      payload: {},
    });
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});
