import type { HookHandlerAdapter, TypedHookInput } from '../hookTypes.js';

export type PromptHookEvaluator = (
  prompt: string,
  input: TypedHookInput,
  signal: AbortSignal,
) => Promise<{ behavior?: 'continue' | 'block'; feedback?: string; data?: Record<string, unknown> }>;

export function createPromptHookHandler(evaluate: PromptHookEvaluator): HookHandlerAdapter {
  return async ({ definition, input, signal }) => {
    if (definition.handler.type !== 'prompt') throw new Error('Expected prompt hook.');
    const result = await evaluate(definition.handler.prompt, input, signal);
    return {
      behavior: result.behavior ?? 'continue',
      ...(result.feedback ? { feedback: result.feedback } : {}),
      ...(result.data ? { data: result.data } : {}),
    };
  };
}
