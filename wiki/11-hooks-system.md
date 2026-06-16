# 11 — Hooks System

## Architecture

Hooks are lifecycle callbacks that inject custom behavior at specific points in
the agent execution pipeline. They allow extending the SDK without modifying
core source.

Location: `src/hooks/actoviqHooks.ts`

### Hook Types

| Hook | When It Runs | Use Case |
|---|---|---|
| **SessionStart** | Before a new session begins execution | Initialize context, validate environment |
| **PostSampling** | After each model response | Filter/modify model output, inject guidance |
| **PostRun** | After a run completes | Logging, metrics, cleanup |
| **Stop** | When a run is aborted or errors | Graceful shutdown, resource release |
| **PostToolUse** | After each tool execution | Audit logging, worktree setup/teardown |
| **PreToolUse** | Before each tool execution | Input validation, rate limiting |

## Module Design

### Hook Composition

Hooks are composed through a merge strategy: base hooks + extra hooks = merged
array. No hooks override each other — all registered hooks run.

```typescript
function mergeActoviqHooks(
  base: ActoviqHooks | undefined,
  extra: ActoviqHooks | undefined,
): ActoviqHooks | undefined {
  const sessionStart = [...(base?.sessionStart ?? []), ...(extra?.sessionStart ?? [])];
  const postSampling = [...(base?.postSampling ?? []), ...(extra?.postSampling ?? [])];
  const postRun = [...(base?.postRun ?? []), ...(extra?.postRun ?? [])];
  const stopHooks = [...(base?.stopHooks ?? []), ...(extra?.stopHooks ?? [])];
  // Return undefined if all empty (avoids empty object allocation)
  // ...
}
```

### Execution Order

Session hooks execute in registration order. For SessionStart hooks:
```typescript
for (const hook of sessionStartHooks) {
  const result = await hook({ sessionId, workDir, model });
  // result.messages? → inject into conversation
  // result.context? → add to session metadata
}
```

## Code Details

### `ActoviqHooks` Type

```typescript
interface ActoviqHooks {
  sessionStart?: ActoviqSessionStartHook[];
  postSampling?: ActoviqPostSamplingHook[];
  postRun?: ActoviqPostRunHook[];
  stopHooks?: ActoviqStopHook[];
}
```

### PostSampling Hook

Runs after each model response, before tool execution:

```typescript
type ActoviqPostSamplingHook = (context: {
  sessionId?: string;
  runId: string;
  messages: MessageParam[];
  model: string;
}) => Promise<{ messages?: MessageParam[] } | void>;
```

Hooks receive the full message array and can return modified messages. This
allows:
- Filtering unwanted content from model responses
- Injecting additional context messages
- Logging model outputs for audit trails

### Stop Hook

Runs when a run is aborted or errors:

```typescript
type ActoviqStopHook = (context: {
  sessionId?: string;
  runId: string;
  reason: 'aborted' | 'error' | 'max_iterations';
  error?: Error;
}) => Promise<void>;
```

### Message Normalization

Hooks receive `MessageParam[]` — the SDK normalizes messages before passing to
hooks to ensure consistent format:

```typescript
function normalizeActoviqHookMessages(messages: MessageParam[] | undefined): MessageParam[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(m =>
    (m.role === 'user' || m.role === 'assistant') &&
    (typeof m.content === 'string' || Array.isArray(m.content))
  );
}
```

### Usage in the ReAct Loop

```typescript
// After model response
const hookResult = await resolveActoviqPostSamplingHooks(hooks);
if (hookResult) {
  messages.push(...hookResult.messages);
}

// On abort/error
await resolveActoviqStopHooks(hooks, { reason: 'aborted', runId });
```
