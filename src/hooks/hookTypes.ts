export type HadamardLifecycleEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'TurnStart'
  | 'TurnEnd'
  | 'ModelRequest'
  | 'ModelResponse'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionDecision'
  | 'Compact'
  | 'Stop'
  | 'WorktreeCreate'
  | 'WorktreeRemove';

export type TypedHookHandler =
  | { type: 'command'; command: string; args?: string[]; cwd?: string }
  | { type: 'prompt'; prompt: string }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface TypedHookDefinition {
  id: string;
  event: HadamardLifecycleEvent;
  matcher?: string;
  handler: TypedHookHandler;
  timeoutMs?: number;
  enabled?: boolean;
  errorPolicy?: 'continue' | 'block';
}

export interface TypedHookInput {
  event: HadamardLifecycleEvent;
  runId: string;
  sessionId?: string;
  cwd: string;
  toolName?: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TypedHookOutput {
  hookId: string;
  event: HadamardLifecycleEvent;
  behavior: 'continue' | 'block';
  feedback?: string;
  data?: Record<string, unknown>;
  durationMs: number;
  error?: string;
}

export interface HookHandlerContext {
  definition: TypedHookDefinition;
  input: TypedHookInput;
  signal: AbortSignal;
}

export type HookHandlerAdapter = (
  context: HookHandlerContext,
) => Promise<Omit<TypedHookOutput, 'hookId' | 'event' | 'durationMs'>>;
