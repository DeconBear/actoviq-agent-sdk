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

export interface RunMetrics {
  durationMs: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  iterationCount: number;
  answerLength: number;
  estimatedCost: number;
}

/** Fixed 5-dimension scoring, each 0-10 */
export interface StandardScore {
  factual: number;      // Factual correctness
  breadth: number;      // Coverage depth
  structure: number;    // Presentation & organization
  citation: number;     // Source quality
  efficiency: number;   // Tool use efficiency (fewer = better)
  overall: number;      // Weighted: factual*0.30 + breadth*0.25 + structure*0.20 + citation*0.15 + efficiency*0.10
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
