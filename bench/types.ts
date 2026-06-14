export type BenchmarkRuntimeTarget =
  | 'clean-sdk'
  | 'bridge-sdk'
  | 'official-claude-sdk'
  | 'parity'
  | 'external-agent';

export type BenchmarkCategory =
  | 'coding'
  | 'tools'
  | 'terminal'
  | 'workflow'
  | 'skills'
  | 'dialogue'
  | 'web'
  | 'memory'
  | 'safety';

export interface BenchmarkBudget {
  maxSeconds?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
}

export interface BenchmarkBehaviorExpectations {
  minSubagentCalls?: number;
  minAgentContinuationCalls?: number;
  minBackgroundSubagentCalls?: number;
  minIsolatedSubagentCalls?: number;
  minSkillUseCount?: number;
  requiredSkillNames?: string[];
  maxToolErrors?: number;
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
  behaviorExpectations?: BenchmarkBehaviorExpectations;
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
      scoreFromStdout?: {
        pattern: string;
        numeratorGroup?: number;
        denominatorGroup?: number;
      };
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
  status?: string;
  runIds?: string[];
  sessionIds?: string[];
  taskIds?: string[];
  requestCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
}

export interface BenchmarkAgentMetrics {
  runtime?: BenchmarkRuntimeTarget | string;
  llmRequestCount?: number;
  requestCount?: number;
  turnCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  subagentCallCount?: number;
  agentContinuationCallCount?: number;
  backgroundSubagentCallCount?: number;
  isolatedSubagentCallCount?: number;
  skillUseCount?: number;
  permissionDenialCount?: number;
  benchmarkInternalAccessCount?: number;
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

export type BenchmarkTrajectoryEventType =
  | 'llm_request'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'subagent_start'
  | 'subagent_result'
  | 'skill_load'
  | 'permission_decision'
  | 'command_verification'
  | 'grader_result'
  | 'compact'
  | 'request_interrupted'
  | 'error';

export interface BenchmarkTrajectoryEvent {
  eventId: string;
  timestamp: string;
  runtime?: BenchmarkRuntimeTarget | string;
  caseId?: string;
  trial?: number;
  actor?: {
    type: 'main-agent' | 'subagent' | 'harness' | 'tool' | 'grader';
    name?: string;
    parentToolUseId?: string | null;
  };
  event: {
    type: BenchmarkTrajectoryEventType;
    name?: string;
    inputSummary?: string;
    outputSummary?: string;
    isError?: boolean;
    durationMs?: number;
    data?: Record<string, unknown>;
  };
}

export interface BenchmarkGraderResult {
  type: BenchmarkGrader['type'] | 'policy';
  passed: boolean;
  message: string;
  command?: BenchmarkCommandResult;
  score?: number;
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
  trajectoryFile?: string;
  trajectoryEventCount?: number;
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
