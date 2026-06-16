# Benchmark Harness Guidelines

This document is the public contributor guide for benchmark work. It contains
repository-safe rules only. Local agent rule files such as `AGENTS.md` and
`CLAUDE.md` are intentionally ignored and must not be used as contributor-facing
benchmark documentation.

## Principles

- Evaluate observable end state, not prose quality.
- Keep task prompts natural. Do not require a fixed plan format, tool order,
  command sequence, or implementation recipe unless that constraint is the task.
- Keep hidden graders, gold fixes, runner internals, and report artifacts out of
  the agent-visible workspace.
- Run each trial in an isolated copied workspace so benchmarks cannot mutate
  source fixtures or the repository checkout.
- Compare runtimes under the same task prompt, fixture, budget, and graders.
- Record behavior traces and metrics as evidence, but keep pass/fail tied to
  deterministic graders.
- Prefer repeated trials for long or flaky cases so variance is visible.

## Runtime Targets

Benchmark cases should declare one `runtimeTarget`:

| Runtime target | Purpose |
| --- | --- |
| `clean-sdk` | Primary in-process Hadamard SDK runtime under evaluation. |
| `bridge-sdk` | Compatibility/runtime reference path (actoviq-bridge-sdk) for Claude Code-like behavior. |
| `official-claude-sdk` | External baseline using Anthropic's official Claude Agent SDK. |
| `parity` | Compare Hadamard SDK against actoviq-bridge-sdk and/or the official SDK baseline. |
| `external-agent` | Run a third-party wrapper through the harness adapter contract. |

Hadamard SDK parity work should treat actoviq-bridge-sdk and the official Claude Agent SDK
as behavioral baselines, not as dependencies. Hadamard SDK code must remain
independent and open-sourceable.

## Scoring

The benchmark score has separate dimensions:

- `task`: deterministic grader result, such as tests, file content, workflow
  state, or policy outcome.
- `efficiency`: budget fit for duration, turns, tool calls, and tokens when a
  case defines those budgets.
- `behavior`: observable quality signals such as tool errors, permission
  denials, subagent usage, and skill usage.

Behavior expectations are optional score signals only. They must not replace
deterministic graders and must not force a prescribed ReAct script in the task
prompt.

## Trajectory And Metrics

Runtime wrappers should emit metrics when available:

- LLM request or turn count
- tool call count and tool error count
- subagent call count
- skill use count
- permission denial count
- token usage and cost
- summarized tool, subagent, permission, compaction, and error events

Long-running wrappers should stream trajectory events while the agent is active
so partial progress is preserved even when the provider or process fails. Do not
store private chain-of-thought. Trajectories should contain auditable summaries
and structured metadata.

## Leakage Rules

The benchmark harness must keep implementation details out of the prompt and
workspace visible to the agent:

- Trial instructions, output files, session files, trajectories, and runner
  internals should live in harness-owned paths outside the copied workspace.
- Runtime wrappers should clear harness-only environment variables before the
  agent loop starts unless a variable is part of the public adapter contract.
- Agent access to hidden graders, gold commands, case manifests, runner source,
  or generated reports should be treated as a policy failure.
- Generated reports and temporary workspaces are artifacts, not source.

## Case Design

Complex benchmark coverage should include:

- multi-file coding and regression repair
- terminal/devops workflows
- subagent-oriented decomposition
- skills and local capability discovery
- dialogue, policy, and tool API interactions
- local docs or web research synthesis
- memory and long-log debugging
- safety and prompt-injection resistance
- long English and Chinese tasks
- competitive-programming stress tasks with hidden judging

For external benchmark suites, add adapters and manifests instead of vendoring
large suites wholesale. Keep external integrations opt-in unless the required
environment is small, deterministic, and practical for local CI.

## Validation Commands

Use the existing npm scripts for harness validation:

```bash
npm run bench:smoke
npm run bench:complex
npm run bench:complex:clean
npm run bench:complex:parity
npm run bench:complex:parity:repeated
npm run bench:adapt:example
```

When benchmark or runtime behavior changes, run at least `npm run bench:smoke`
before declaring the change ready. Broaden validation when the changed code
touches scoring, runners, adapters, or case definitions.
