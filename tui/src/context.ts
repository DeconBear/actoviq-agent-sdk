// ── ContentBlock: the fundamental message unit ────────────────────

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'separator'; iteration: number; runId?: string }
  | { type: 'thinking'; text: string; collapsed: boolean }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; status: ToolStatus; iteration?: number; provider?: 'local' | 'mcp'; progressMessage?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; durationMs?: number; iteration?: number };

// ── UIMessage ─────────────────────────────────────────────────────

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: string;
  compactBoundary?: boolean;
}

// ── Permission ────────────────────────────────────────────────────

export interface PermissionState {
  toolName: string;
  toolDescription?: string;
  input: Record<string, unknown>;
  resolve: (allowed: boolean) => void;
}

export type OverlayPanel = 'transcript' | 'todos' | 'help' | 'model-picker' | 'sessions' | 'memory' | null;
