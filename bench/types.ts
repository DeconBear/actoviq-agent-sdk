export type BenchmarkRuntimeTarget =
  | 'clean-sdk'
  | 'bridge-sdk'
  | 'official-claude-sdk'
  | 'parity'
  | 'external-agent';

export type BenchmarkCategory =
  | 'coding'
  | 'tools'
  | 'workflow'
  | 'memory'
  | 'safety';

export interface BenchmarkBudget {
  maxSeconds?: number;
  maxToolCalls?: number;
  maxTokens?: number;
}

export interface BenchmarkCase {
  id: string;
  title: string;
  category: BenchmarkCategory;
  runtimeTarget: BenchmarkRuntimeTarget;
  instruction: string;
  fixture?: string;
  tags?: string[];
  trials?: number;
  budget?: BenchmarkBudget;
  setupCommand?: string;
  goldCommand?: string;
  graders: BenchmarkGrader[];
  notes?: string;
}

export type BenchmarkGrader =
  | {
      type: 'command';
      command: string;
      timeoutMs?: number;
      passExitCode?: number;
    }
  | {
      type: 'file_contains';
      path: string;
      text: string;
    }
  | {
      type: 'file_exists';
      path: string;
    }
  | {
      type: 'file_absent';
      path: string;
    };

export interface BenchmarkCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface BenchmarkToolCallMetric {
  name: string;
  publicName?: string;
  isError?: boolean;
  durationMs?: number;
  parentToolUseId?: string | null;
}

export interface BenchmarkSubagentMetric {
  name?: string;
  description?: string;
  taskType?: string;
}

export interface BenchmarkAgentMetrics {
  runtime?: BenchmarkRuntimeTarget | string;
  llmRequestCount?: number;
  requestCount?: number;
  turnCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  subagentCallCount?: number;
  skillUseCount?: number;
  permissionDenialCount?: number;
  eventCount?: number;
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  toolCalls?: BenchmarkToolCallMetric[];
  subagents?: BenchmarkSubagentMetric[];
  skills?: string[];
}

export interface BenchmarkScore {
  total: number;
  task: number;
  efficiency: number;
  behavior: number;
}

export interface BenchmarkGraderResult {
  type: BenchmarkGrader['type'];
  passed: boolean;
  message: string;
  command?: BenchmarkCommandResult;
}

export interface BenchmarkTrialResult {
  caseId: string;
  title: string;
  category: BenchmarkCategory;
  runtimeTarget: BenchmarkRuntimeTarget;
  trial: number;
  workspace: string;
  usedGold: boolean;
  agentCommand?: BenchmarkCommandResult;
  setupCommand?: BenchmarkCommandResult;
  graders: BenchmarkGraderResult[];
  agentMetrics?: BenchmarkAgentMetrics;
  score: BenchmarkScore;
  passed: boolean;
  durationMs: number;
}

export interface BenchmarkReport {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalTrials: number;
  passedTrials: number;
  failedTrials: number;
  passRate: number;
  averageScore: number;
  cases: BenchmarkTrialResult[];
}
