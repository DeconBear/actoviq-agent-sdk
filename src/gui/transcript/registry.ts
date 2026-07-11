/**
 * Tool family → renderer key mapping (browser cards live in clientBundle).
 * Kept as a typed registry so tests and future React islands share names.
 */
export type ToolRendererKey =
  | 'bash'
  | 'edit'
  | 'todo'
  | 'read'
  | 'search'
  | 'web'
  | 'task'
  | 'question'
  | 'generic';

export const TOOL_RENDERER_KEYS: readonly ToolRendererKey[] = [
  'bash',
  'edit',
  'todo',
  'read',
  'search',
  'web',
  'task',
  'question',
  'generic',
] as const;

export function resolveToolRendererKey(toolName: string): ToolRendererKey {
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash' || name === 'powershell') return 'bash';
  if (name === 'edit' || name === 'write' || name === 'notebookedit') return 'edit';
  if (name === 'todowrite' || name === 'todo') return 'todo';
  if (name === 'read') return 'read';
  if (name === 'glob' || name === 'grep') return 'search';
  if (name === 'tavilysearch' || name === 'websearch' || name === 'webfetch') return 'web';
  if (name === 'task' || name === 'agent') return 'task';
  if (name === 'askuserquestion') return 'question';
  return 'generic';
}
