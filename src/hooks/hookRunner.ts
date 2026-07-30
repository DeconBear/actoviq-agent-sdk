import { runCommandHook } from './handlers/commandHook.js';
import { runHttpHook } from './handlers/httpHook.js';
import type {
  HookHandlerAdapter,
  TypedHookDefinition,
  TypedHookInput,
  TypedHookOutput,
} from './hookTypes.js';

export interface HookRunnerOptions {
  hooks: TypedHookDefinition[];
  promptHandler?: HookHandlerAdapter;
  defaultTimeoutMs?: number;
}

export class HookRunner {
  private readonly hooks: TypedHookDefinition[];
  private readonly handlers: Record<string, HookHandlerAdapter | undefined>;
  private readonly defaultTimeoutMs: number;

  constructor(options: HookRunnerOptions) {
    const seen = new Set<string>();
    this.hooks = options.hooks.filter(hook => {
      if (seen.has(hook.id)) return false;
      seen.add(hook.id);
      return hook.enabled !== false;
    });
    this.handlers = {
      command: runCommandHook,
      http: runHttpHook,
      prompt: options.promptHandler,
    };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async run(input: TypedHookInput): Promise<TypedHookOutput[]> {
    const outputs: TypedHookOutput[] = [];
    for (const definition of this.hooks) {
      if (definition.event !== input.event || !matches(definition.matcher, input)) continue;
      const started = Date.now();
      const handler = this.handlers[definition.handler.type];
      if (!handler) {
        outputs.push({
          hookId: definition.id,
          event: input.event,
          behavior: definition.errorPolicy === 'block' ? 'block' : 'continue',
          error: `No ${definition.handler.type} hook adapter is configured.`,
          durationMs: Date.now() - started,
        });
        continue;
      }
      const timeout = AbortSignal.timeout(definition.timeoutMs ?? this.defaultTimeoutMs);
      const signal = input.signal
        ? AbortSignal.any([input.signal, timeout])
        : timeout;
      try {
        const result = await handler({ definition, input, signal });
        outputs.push({
          hookId: definition.id,
          event: input.event,
          ...result,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        outputs.push({
          hookId: definition.id,
          event: input.event,
          behavior: definition.errorPolicy === 'block' ? 'block' : 'continue',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        });
      }
      if (outputs.at(-1)?.behavior === 'block') break;
    }
    return outputs;
  }
}

function matches(pattern: string | undefined, input: TypedHookInput): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'u').test(input.toolName ?? input.event);
  } catch {
    return false;
  }
}
