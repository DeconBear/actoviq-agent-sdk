import { describe, expect, it, vi } from 'vitest';

import { HookRunner } from '../src/hooks/hookRunner.js';
import type { HookHandlerAdapter } from '../src/hooks/hookTypes.js';

describe('HookRunner', () => {
  it('runs matching hooks in order, dedupes ids, and stops on block', async () => {
    const promptHandler = vi.fn<HookHandlerAdapter>(async ({ definition }) => {
      const prompt = definition.handler.type === 'prompt' ? definition.handler.prompt : '';
      return {
        behavior: prompt === 'block' ? 'block' : 'continue',
        feedback: prompt,
      };
    });
    const runner = new HookRunner({
      hooks: [
        { id: 'first', event: 'PreToolUse', matcher: '^Write$', handler: { type: 'prompt', prompt: 'continue' } },
        { id: 'first', event: 'PreToolUse', handler: { type: 'prompt', prompt: 'duplicate' } },
        { id: 'block', event: 'PreToolUse', handler: { type: 'prompt', prompt: 'block' } },
        { id: 'after', event: 'PreToolUse', handler: { type: 'prompt', prompt: 'after' } },
      ],
      promptHandler,
    });
    const outputs = await runner.run({
      event: 'PreToolUse',
      runId: 'run',
      cwd: process.cwd(),
      toolName: 'Write',
      payload: {},
    });
    expect(outputs.map(output => output.hookId)).toEqual(['first', 'block']);
    expect(outputs.at(-1)?.behavior).toBe('block');
  });
});
