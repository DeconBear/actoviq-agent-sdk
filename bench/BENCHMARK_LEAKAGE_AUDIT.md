# Benchmark Leakage and Validity Audit

Date: 2026-06-04

This audit was triggered because a previous single-run report showed Clean SDK
at 8/8 with a 1.000 average score. That result was too easy to over-interpret.
This file records what was checked, what was fixed, and how to interpret the
current benchmark.

## Summary

Clean SDK should not be described as "stable full score" on the current
benchmark. The earlier 1.000 result was a real run, but it was not a strong
validity claim because the harness did not yet audit benchmark-internal access
and the suite only used one trial per case.

After the audit:

- No run showed evidence that Clean SDK read `goldCommand` or `bench/cases`.
- The old harness did expose `.actoviq-bench` inside the trial workspace, so
  normal `ls` or recursive directory listing could touch benchmark internals.
- The harness now stores instruction, output, trajectory, and session files in a
  sibling temporary internal directory outside the agent-visible workspace.
- Runtime wrappers now clear `ACTOVIQ_BENCH_*` environment variables before
  starting the agent loop.
- The runner now adds a synthetic `policy` grader that fails the trial if tool
  trajectories access benchmark internals.
- The dialogue case checker was too literal about customer-facing wording; it
  now checks the intended refund/upgrade semantics instead of one exact phrase.

The current benchmark is better, but it is still not sufficient as a final
Claude Code-like capability claim. It needs repeated trials, stronger hidden
graders, and subagent-beneficial cases where delegation is naturally useful.

## Leakage Findings

### Direct Answer Leakage

No direct answer leakage was found in the Clean SDK trajectories that were
inspected. Tool calls stayed within copied fixture workspaces and did not show
reads of `bench/cases`, `goldCommand`, `bench/reports`, or runner source files.

### Structural Leakage Risk

The case JSON files include `goldCommand` values for gold-mode harness
validation. Those values are not copied into the trial workspace and are not
included in the task prompt. However, if a benchmark agent can read outside the
workspace, it could theoretically locate those source files. This is why the
harness now audits benchmark-internal access from trajectory logs.

### Workspace Internal Exposure

Before this audit, runner internals lived under `<workspace>/.actoviq-bench`.
That was a design flaw. A normal workspace exploration command could see the
benchmark instruction/output/trajectory files. The audit first made such access
a policy failure, which caused Clean SDK to fail two cases where Bash/PowerShell
listed `.actoviq-bench`. The fix was to move runner internals outside the trial
workspace.

## Fixes Made

- `bench/runner.ts`
  - stores trial internals in `actoviq-bench-internal-*` sibling temp folders;
  - adds benchmark-internal trajectory audit;
  - appends a `policy` grader to each trial;
  - records `benchmarkInternalAccessCount` in metrics;
  - penalizes benchmark-internal access in behavior scoring.
- `bench/agents/clean-sdk-runner.ts`
  - uses the external internal directory for sessions;
  - clears `ACTOVIQ_BENCH_*` before the agent loop.
- `bench/agents/bridge-sdk-runner.ts`
  - clears `ACTOVIQ_BENCH_*` before the bridge agent loop.
- `bench/agents/official-claude-sdk-runner.ts`
  - clears `ACTOVIQ_BENCH_*` before the official SDK agent loop.
- `bench/fixtures/dialogue/support-policy/check-support-state.mjs`
  - accepts semantically correct refund approval and plan-upgrade denial wording.
- `AGENTS.md` and `bench/README.md`
  - document the benchmark-internal isolation and policy-failure rule.

## Validation Runs

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | Pass | TypeScript checks passed after harness changes. |
| `npm run bench -- --cases "bench/cases/complex/dialogue-policy-tool-api.json" --use-gold --report-dir bench/reports/dialogue-gold-check` | Pass | Gold-mode dialogue checker validation. |
| `npm run bench -- --cases "bench/cases/complex/dialogue-policy-tool-api.json" --agent-command "tsx {cleanSdkRunner}" --report-dir bench/reports/dialogue-clean-check` | Pass | Clean SDK dialogue case passes after checker repair. |
| `npm run bench -- --cases "bench/cases/complex/dialogue-policy-tool-api.json" --agent-command "tsx {officialClaudeSdkRunner}" --report-dir bench/reports/dialogue-official-check` | Pass | Official SDK dialogue case passes after checker repair. |
| `npm run bench -- --cases "bench/cases/complex/workflow-subagent-review.json" --agent-command "tsx {cleanSdkRunner}" --report-dir bench/reports/workflow-clean-check` | Pass | Clean SDK workflow case passed in targeted rerun after a prior transient `undici` termination. |
| `npm run bench:complex:parity` | Mixed | A full parity run before the final dialogue checker broadening showed Clean 6/8, Bridge 8/8, Official 7/8, with `benchmarkInternalAccessCount = 0` for all runtimes. |

## Current Interpretation

The benchmark no longer supports the simple statement "Clean SDK is full score."
The more accurate statement is:

- Clean SDK can pass all eight complex cases in a single run after leakage
  isolation, and targeted reruns passed the previously suspicious cases.
- Clean SDK has shown run-to-run instability on this suite, including one
  transient network/API termination and one dialogue case that exposed an overly
  literal grader.
- Bridge SDK was the most stable in the latest full parity run.
- Official Claude Agent SDK continues to show stronger observable subagent usage
  in some runs, but also has wording and efficiency variability.
- No current run showed benchmark-internal access after the isolation fix.

## Remaining Benchmark Weaknesses

- `goldCommand` still lives in case JSON for source-level gold validation. That
  is acceptable for local harness development, but it is not equivalent to a
  hidden external evaluation set.
- Most graders are visible fixture tests or local checker scripts. They are
  deterministic but not fully hidden.
- The suite uses one trial per case by default. Use
  `bench:complex:parity:repeated` when the comparison needs repeated trials,
  pass@k or pass^k, and variance.
- Subagent usage is now measurable as an optional behavior-expectation score
  signal, but deterministic task correctness still does not require a fixed
  subagent script.
- The harness still relies on trajectory auditing rather than OS-level sandboxing
  to detect out-of-workspace information access.

## Next Steps

- Move gold/reference commands into a separate non-agent-readable fixture source
  for serious evaluation runs.
- Add hidden or generated mutation tests for coding/workflow cases.
- Add a benchmark-internal canary case that intentionally fails if an agent
  reads internal harness paths or benchmark source files.
- Add more generated subagent-beneficial variants where delegation materially
  improves reliability under the same task prompt.
