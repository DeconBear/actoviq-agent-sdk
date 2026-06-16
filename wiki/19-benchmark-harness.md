# 19 — Benchmark Harness

## Architecture

The benchmark harness evaluates agent behavior across task suites by running
SDK instances in isolated workspaces and grading deterministic end states.
It compares Hadamard SDK, actoviq-bridge-sdk, and the official Claude Agent SDK.

Location: `bench/*`

### Design Principles

- **Isolated workspaces**: each trial runs in a copied temp directory
- **Deterministic graders**: final state checks (test passes, file contents,
  event counts), not prompt compliance
- **No forced recipes**: the agent prompt contains the task, not the solution
- **Behavior signals**: optional expectations (min subagent calls, max tool
  errors) affect behavior score only

## Module Design

### Files

| File | Role |
|---|---|
| `bench/runner.ts` | Main benchmark runner |
| `bench/run-parity.ts` | Three-way parity comparison runner |
| `bench/types.ts` | Benchmark case, report, grader types |
| `bench/agents/clean-sdk-runner.ts` | Hadamard SDK benchmark wrapper |
| `bench/agents/bridge-sdk-runner.ts` | Bridge SDK benchmark wrapper |
| `bench/agents/official-claude-sdk-runner.ts` | Official Claude Agent SDK wrapper |
| `bench/cases/` | Benchmark case definitions (JSON) |
| `bench/fixtures/` | Isolated workspace fixtures |
| `bench/adapters/` | External benchmark suite adapters |

### Case Definition

```json
{
  "name": "workflow-multi-module-parallel",
  "description": "Fix bugs across 3 independent modules using parallel subagents",
  "runtimeTarget": "parity",
  "fixture": "bench/fixtures/workflow/multi-module-regression",
  "instruction": "Because the modules are independent, delegate each module's investigation and fix to a separate subagent running in parallel.",
  "graders": [
    { "type": "file_contains", "path": "modules/math/calc.js", "contains": "price * (1 + rate)" },
    { "type": "file_contains", "path": "modules/string/format.js", "contains": ".toLowerCase()" }
  ],
  "behaviorExpectations": {
    "minSubagentCalls": 3,
    "minBackgroundSubagentCalls": 2
  }
}
```

### Grading Dimensions

| Dimension | Weight | What It Measures |
|---|---|---|
| **Deterministic** | Primary | File contents, test pass/fail, exact output match |
| **Behavior** | Secondary | Subagent calls, skill use, tool error rate |
| **Trajectory** | Diagnostic | Request count, token usage, timing |

### Agent Runners

Each runner is a standalone script that:
1. Reads the case definition
2. Copies the fixture to an isolated temp directory
3. Initializes the SDK (Hadamard, Bridge, or Official)
4. Sends the instruction as the agent prompt
5. Records all events, tool calls, and results
6. Runs graders against the final workspace state
7. Outputs a structured report

```typescript
// clean-sdk-runner.ts (simplified)
const sdk = await createAgentSdk({
  workDir: workspace,
  tools: createActoviqCoreTools({ cwd: workspace }),
  permissionMode: 'bypassPermissions',
});
const result = await sdk.run(instruction, {
  systemPrompt: BENCHMARK_SYSTEM_PROMPT,
  maxToolIterations: maxTurns,
});
// Run graders, write report
```

### Parity Runner

`bench/run-parity.ts` runs the same case against all three runtimes and produces
a comparison table:

```
| Runtime | Passed | Total | Pass Rate |
|---|---:|---:|---:|
| Hadamard SDK | 8 | 8 | 100.00% |
| actoviq-bridge-sdk | 8 | 8 | 100.00% |
| Official Claude Agent SDK | 7 | 8 | 87.50% |
```

## Code Details

### `bench/runner.ts` — Core Loop

```typescript
async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  for (const caseDef of options.cases) {
    // 1. Validate case definition
    // 2. Copy fixture to isolated workspace
    // 3. Build agent command (SDK runner + case-specific args)
    // 4. Execute agent (child process or in-process)
    // 5. Run graders against workspace
    // 6. Collect trajectory events
    // 7. Write trial report
  }
  // Aggregate into suite report
}
```

### Grader Types

| Grader | What It Checks |
|---|---|
| `file_contains` | File contains specific string |
| `file_equals` | File exactly matches gold content |
| `test_passes` | `node test.mjs` exits 0 |
| `command_output` | Shell command output matches pattern |
| `no_file_exists` | File does NOT exist (safety checks) |

### Report Structure

```
bench/reports/
├── clean-sdk/          # Hadamard SDK trial reports
│   └── trajectories/   # JSONL per-trial event logs
├── bridge-sdk/         # Bridge SDK trial reports
├── official-claude-sdk/# Official SDK trial reports
└── parity/             # Comparison reports
```

### Budget Propagation

```typescript
// Case declares budget.maxTurns:
//   → Hadamard SDK: ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS env var
//   → Bridge SDK: --max-turns CLI flag
//   → Official SDK: maxTurns option
// No declared budget:
//   → All runtimes run uncapped (Infinity)
```

### Behavior Expectations

```typescript
interface BehaviorExpectations {
  minSubagentCalls?: number;         // Minimum expected Agent/Task calls
  minBackgroundSubagentCalls?: number;// Minimum expected background delegations
  maxToolErrors?: number;            // Maximum tolerable tool errors
  requiredSkillNames?: string[];     // Skills that should be used
  minSkillUseCount?: number;         // Minimum skill invocations
}
```

These affect the **behavior score** only. They don't replace deterministic
graders and don't force a prescribed tool sequence in the prompt.
