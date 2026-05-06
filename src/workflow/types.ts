import type { AgentEvent, AgentMcpServerDefinition } from '../types.js';

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  description: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string | null;
  mcpServers?: AgentMcpServerDefinition[];
  dependsOn: string[];
  retries?: number;
  timeoutMs?: number;
}

export interface WorkflowParameter {
  type: 'string' | 'number' | 'boolean' | 'json';
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  parameters?: Record<string, WorkflowParameter>;
  model?: string | null;
  systemPrompt?: string;
}

export interface WorkflowStepResult {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  text: string;
  toolCalls: string[];
  durationMs: number;
  sessionId: string;
  error?: string;
}

export interface WorkflowRunResult {
  runId: string;
  workflowName: string;
  steps: WorkflowStepResult[];
  text: string;
  durationMs: number;
  status: 'completed' | 'partial' | 'failed';
}

export interface WorkflowRunOptions {
  workDir: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}
