# Actoviq Agent Benchmark Harness

This directory contains a repository-local benchmark harness for evaluating Actoviq agent runtimes and compatible external coding agents.

## Design Principles

- Evaluate end state, not prose quality. Prefer deterministic graders such as command exit codes, file state, workflow events, and permission decisions.
- Keep task instructions natural. Do not over-constrain the model with a required plan, required tool sequence, or implementation recipe unless the task itself is about following a policy.
- Keep gold fixes and graders separate from the agent prompt. The agent receives the instruction and workspace; the harness owns scoring.
- Run in isolated copied workspaces. A benchmark case must not mutate the source fixture or the repository checkout.
- Keep harness internals outside the trial workspace. Instruction, output, trajectory, and session files are stored in a sibling temporary directory, and runtime wrappers clear `ACTOVIQ_BENCH_*` variables before the agent loop starts.
- Record cost and trace metadata when the agent wrapper can provide it, but do not make a run pass solely because the trace looks good.
- Report repeated-run reliability. Single-run pass rate is useful, but flaky tasks should be visible.
- Evaluate general coding-agent behavior, not only single-turn prompt completion. Cases should allow natural tool use, verification loops, optional subagent delegation, and skill loading when those capabilities are relevant.
- Do not force a fixed ReAct script in the prompt. The harness should measure tool calls, LLM turns, subagent usage, skill usage, and error rates from logs instead of requiring a prescribed sequence.

## Scoring and Metrics

Each trial keeps `passed` as the deterministic end-state result and adds a separate score:

- `task`: whether graders passed.
- `efficiency`: budget fit for duration, tool calls, and tokens when a case defines those budgets.
- `behavior`: observable execution quality signals such as tool errors and permission denials.
- `total`: weighted score, currently `70% task + 20% efficiency + 10% behavior`.

Runtime wrappers should write JSON to `ACTOVIQ_BENCH_OUTPUT_FILE` with a `metrics` object when possible. Supported metrics include `llmRequestCount`, `toolCallCount`, `toolErrorCount`, `subagentCallCount`, `skillUseCount`, `permissionDenialCount`, token usage, cost, and summarized tool/subagent lists.
Long-running wrappers should also stream trajectory events while the run is active so interrupted runs still retain request, tool, permission, compaction, and error evidence.
The harness also scans JSONL trajectories for benchmark-internal access such as `.actoviq-bench`, `actoviq-bench-internal`, `goldCommand`, `bench/cases`, and `bench/reports`; detected access is reported as a `policy` grader failure.

Cases may declare `behaviorExpectations` such as `minSubagentCalls`, `minSkillUseCount`, `requiredSkillNames`, or `maxToolErrors`. These expectations affect the behavior score only; they do not turn a natural task prompt into a required ReAct script and do not replace deterministic end-state graders.
`subagentCallCount` should count actual delegated agents only, not internal shell/tool helper tasks such as local bash execution events.
Cases may also set `budget.maxTurns`; the parity runner passes it as `ACTOVIQ_BENCH_MAX_TURNS` for Bridge SDK and official Claude Agent SDK wrappers, and as `ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS` for the Clean SDK wrapper.

## Runtime Targets

Actoviq has two agent runtime surfaces:

- `clean-sdk`: the in-process public SDK built around `createAgentSdk()`.
- `bridge-sdk`: the compatibility/runtime path that wraps Claude Code behavior.
- `official-claude-sdk`: Anthropic's official Claude Agent SDK / Claude Code SDK baseline.

The Clean SDK is expected to converge toward Claude Code capability parity. Benchmark cases that compare the two should use `runtimeTarget: "parity"` and run both wrappers against the same fixture and grader.

## Commands

Validate the harness with gold fixes:

```bash
npm run bench:smoke
```

Run the smoke cases against the Clean SDK:

```bash
npm run bench:clean
```

Run the smoke cases against the Bridge SDK:

```bash
npm run bench:bridge
```

Run the smoke cases against the official Claude Agent SDK baseline:

```bash
npm run bench:official
```

Run the same smoke cases against Clean SDK, Bridge SDK, and the official Claude Agent SDK baseline, then write a parity report:

```bash
npm run bench:parity
```

Validate the complex local cases with gold fixes:

```bash
npm run bench:complex
```

Run the complex cases against the Clean SDK:

```bash
npm run bench:complex:clean
```

Run the complex cases against Clean SDK, Bridge SDK, and the official Claude Agent SDK baseline:

```bash
npm run bench:complex:parity
```

Run repeated complex parity trials for variance and pass-rate stability:

```bash
npm run bench:complex:parity:repeated
```

Validate Chinese-language benchmark cases with gold fixes:

```bash
npm run bench:zh
```

Validate longer English benchmark cases with gold fixes:

```bash
npm run bench:long
```

Validate live-web benchmark cases with gold fixes:

```bash
npm run bench:live-web
```

Run live-web cases against real agents only when network/search credentials and skill availability are expected:

```bash
npm run bench:live-web:parity
```

Validate from-scratch stress project cases with gold fixes:

```bash
npm run bench:stress
```

Run from-scratch stress project cases against all parity runtimes:

```bash
npm run bench:stress:parity
```

Validate the Codeforces-derived competitive-programming stress suite with gold fixes:

```bash
npm run bench:cp
```

Run the competitive-programming suite against all parity runtimes:

```bash
npm run bench:cp:parity
```

The competitive-programming suite exposes exactly one public sample per problem. Agents may run `npm run sample`, `npm run run`, and the workspace `npm run judge` command, but that judge reports only `PASS` or `FAIL`. The final benchmark grader reports per-problem status after the agent run and uses `SOLVED x/10` for partial task credit.

Validate the authentic hard competitive-programming suite with gold fixes:

```bash
npm run bench:cp-hard
```

Run the authentic hard suite against all parity runtimes:

```bash
npm run bench:cp-hard:parity
```

Generate example adapted cases from an external-style manifest:

```bash
npm run bench:adapt:example
```

Run benchmark cases against an external agent command:

```bash
npm run bench -- --cases "bench/cases/smoke/*.json" --trials 5 --agent-command "node path/to/agent-wrapper.mjs"
```

The harness runs the command in the trial workspace and provides these environment variables:

- `ACTOVIQ_BENCH_CASE_ID`
- `ACTOVIQ_BENCH_WORKSPACE`
- `ACTOVIQ_BENCH_INSTRUCTION`
- `ACTOVIQ_BENCH_INSTRUCTION_FILE`
- `ACTOVIQ_BENCH_OUTPUT_FILE`
- `ACTOVIQ_BENCH_RUNTIME_TARGET`

The command may also use placeholders: `{repoRoot}`, `{cleanSdkRunner}`, `{bridgeSdkRunner}`, `{officialClaudeSdkRunner}`, `{caseId}`, `{workspace}`, `{instructionFile}`, `{outputFile}`.

Reports are written to `bench/reports/latest.json` and `bench/reports/latest.md`.
Runtime-specific scripts write to `bench/reports/clean-sdk/`, `bench/reports/bridge-sdk/`, `bench/reports/official-claude-sdk/`, and `bench/reports/parity/`. Each trial also archives a JSONL trajectory under the selected report directory's `trajectories/` folder when trajectory events are available.

For the advanced Claude Code-like capability benchmark plan, see `bench/AGENT_CAPABILITY_BENCHMARK_DESIGN.md`.
For contributor-facing benchmark harness rules, see `bench/BENCHMARK_HARNESS_GUIDELINES.md`.
For the benchmark leakage and validity audit, see `bench/BENCHMARK_LEAKAGE_AUDIT.md`.
For the checked-in three-runtime complex benchmark result summary, see `bench/AGENT_RUNTIME_BENCHMARK_RESULTS.md`.
For external benchmark manifest conversion, see `bench/adapters/README.md`.
