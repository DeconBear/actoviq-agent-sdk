/**
 * Standard Benchmark Types — v0.5.0
 * Fixed scoring dimensions, immutable per-run records.
 */
export interface BenchmarkTask {
  id: string;
  title: string;
  category: 'reasoning' | 'coding' | 'analysis' | 'research' | 'safety';
  prompt: string;
  /** Expected key topics/terms the answer should cover (for coverage scoring) */
  expectedCoverage: string[];
  /** Execution track: fixture dir name under bench/fixtures/agentic/ (copied to an isolated workspace). */
  fixture?: string;
  /** Execution track: shell command run in the workspace after the agent finishes; exit 0 = verified pass. */
  verify?: string;
}

export interface AgentConfig {
  name: 'hadamard' | 'bridge' | 'official';
  label: string;
  model: string;
  maxTokens: number;
  /** Whether web search tools are available */
  hasWebSearch: boolean;
  /** Whether Team tool is available */
  hasTeamTool: boolean;
}

export interface ToolCallRecord {
  name: string;
  durationMs: number;
  isError: boolean;
  inputSummary: string;
}

export interface RunMetrics {
  durationMs: number;
  toolCallCount: number;
  toolCalls: ToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  iterationCount: number;
  answerLength: number;
  estimatedCost: number;
  /** Execution track: did the verifier command pass? */
  verified?: boolean;
  /** Execution track: trimmed verifier stdout/stderr. */
  verifyOutput?: string;
  /** Execution track: workspace files the agent created or modified (relative paths). */
  filesChanged?: string[];
}

/** Fixed 5-dimension scoring, each 0-10 */
export interface StandardScore {
  factual: number;      // Factual correctness
  breadth: number;      // Coverage depth
  structure: number;    // Presentation & organization
  citation: number;     // Source quality
  efficiency: number;   // Tool use efficiency (fewer = better)
  overall: number;      // Weighted: factual*0.30 + breadth*0.25 + structure*0.20 + citation*0.15 + efficiency*0.10
  comment?: string;     // Judge's 1-2 sentence rationale (best quality / worst flaw)
  judgeFailed?: boolean; // True if the judge produced unparseable output (exclude from averages)
}

export interface BenchmarkRun {
  runId: string;
  timestamp: string;
  task: BenchmarkTask;
  agent: AgentConfig;
  answer: string;
  metrics: RunMetrics;
  scores: StandardScore;
}

export interface BenchmarkRecord {
  version: '0.5.0';
  tasks: BenchmarkTask[];
  agents: AgentConfig[];
  runs: BenchmarkRun[];
}
