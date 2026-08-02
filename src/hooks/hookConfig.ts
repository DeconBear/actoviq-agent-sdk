import type {
  HadamardLifecycleEvent,
  TypedHookDefinition,
  TypedHookHandler,
} from './hookTypes.js';

const EVENTS = new Set<HadamardLifecycleEvent>([
  'SessionStart', 'SessionEnd', 'TurnStart', 'TurnEnd',
  'ModelRequest', 'ModelResponse', 'PreToolUse', 'PostToolUse',
  'PermissionDecision', 'Compact', 'Stop', 'WorktreeCreate', 'WorktreeRemove',
]);

export function parseTypedHooks(value: unknown): {
  hooks: TypedHookDefinition[];
  issues: string[];
} {
  if (value === undefined) return { hooks: [], issues: [] };
  if (!Array.isArray(value)) return { hooks: [], issues: ['typedHooks must be an array.'] };
  const hooks: TypedHookDefinition[] = [];
  const issues: string[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(`typedHooks[${index}] must be an object.`);
      return;
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      issues.push(`typedHooks[${index}].id is required.`);
      return;
    }
    const id = item.id.trim();
    if (ids.has(id)) {
      issues.push(`typedHooks[${index}].id duplicates "${id}".`);
      return;
    }
    if (typeof item.event !== 'string' || !EVENTS.has(item.event as HadamardLifecycleEvent)) {
      issues.push(`typedHooks[${index}].event is invalid.`);
      return;
    }
    if (typeof item.matcher === 'string') {
      try {
        new RegExp(item.matcher, 'u');
      } catch {
        issues.push(`typedHooks[${index}].matcher is not a valid regular expression.`);
        return;
      }
    }
    const handler = parseHandler(item.handler);
    if (!handler) {
      issues.push(`typedHooks[${index}].handler is invalid.`);
      return;
    }
    ids.add(id);
    hooks.push({
      id,
      event: item.event as HadamardLifecycleEvent,
      handler,
      ...(typeof item.matcher === 'string' ? { matcher: item.matcher } : {}),
      ...(typeof item.timeoutMs === 'number' && item.timeoutMs > 0 ? { timeoutMs: item.timeoutMs } : {}),
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
      ...(item.errorPolicy === 'block' || item.errorPolicy === 'continue'
        ? { errorPolicy: item.errorPolicy }
        : {}),
    });
  });
  return { hooks, issues };
}

function parseHandler(value: unknown): TypedHookHandler | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'command' && typeof value.command === 'string' && value.command.trim()) {
    return {
      type: 'command',
      command: value.command.trim(),
      ...(Array.isArray(value.args)
        ? { args: value.args.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    };
  }
  if (value.type === 'prompt' && typeof value.prompt === 'string' && value.prompt.trim()) {
    return { type: 'prompt', prompt: value.prompt.trim() };
  }
  if (
    value.type === 'http'
    && typeof value.url === 'string'
    && isAllowedHttpHookUrl(value.url.trim())
  ) {
    return {
      type: 'http',
      url: value.url.trim(),
      ...(isRecord(value.headers)
        ? {
            headers: Object.fromEntries(
              Object.entries(value.headers)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            ),
          }
        : {}),
    };
  }
  return undefined;
}

function isAllowedHttpHookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '::1';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
