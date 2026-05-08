import type { AgentEvent, AgentRunResult } from 'actoviq-agent-sdk';

// Re-export for convenience
export type { AgentEvent, AgentRunResult };

export interface SlashCommand {
  name: string;
  args: string;
}

export interface StreamState {
  events: AgentEvent[];
  text: string;
  streaming: boolean;
  runId: string | null;
  iteration: number;
  error: string | null;
  result: AgentRunResult | null;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
