# Repository Guidelines

## Project Structure & Module Organization

Core source lives in `src/`. Key areas include `src/runtime` for the SDK loop, `src/memory` for session-memory and compact logic, `src/buddy` for companion features, `src/workspace` for workspace helpers, and `src/tools` for built-in tool definitions. Tests live in `tests/` and use `*.spec.ts` naming. Examples live in `examples/`; keep them runnable through npm scripts. `scripts/` contains build and packaging helpers. Do not edit `dist/` directly; it is generated.

## Build, Test, and Development Commands

- `npm run typecheck`: run TypeScript checks with no emit.
- `npm test`: run the Vitest suite once.
- `npm run build`: clean `dist/` and compile the package.
- `npm pack --dry-run`: verify the publishable npm package contents.
- `npm run smoke`: run the live smoke script against local configuration.
- `npm run example:quickstart`: run the basic SDK example.


## Coding Style & Naming Conventions

Use TypeScript with ESM imports and 2-space indentation. Prefer small, focused modules and explicit types on exported APIs. Use `camelCase` for functions and variables, `PascalCase` for classes and exported types, and descriptive file names such as `actoviqCompact.ts` or `agent-client.spec.ts`. Keep public naming Actoviq-branded. Avoid editing generated assets or introducing secrets into tracked files.

## Testing Guidelines

Vitest is the test runner. Add or update tests for any runtime, memory, compact, or API-surface change. Keep tests in `tests/` and mirror the feature under test. Favor behavior-level assertions over snapshot-heavy tests. Before opening a PR, run `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run`.

## Commit & Pull Request Guidelines

Follow the existing commit style: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `ci: ...`. Keep messages imperative and scoped to the change. PRs should include a short summary, linked issue if applicable, validation steps run locally, and any docs/example updates required by API changes. Include terminal output or screenshots only when they clarify behavior.

## Security & Configuration Tips

Never commit real credentials. Local config should live outside Git, for example in `~/.actoviq/settings.json` or ignored local JSON files. The `plan/` directory is intentionally local-only and excluded from Git and npm packaging.

## Runtime Architecture

This repository has two agent runtime surfaces:

- **Clean SDK**: the in-process public SDK path built around `createAgentSdk()` and the source under `src/runtime`, `src/tools`, `src/workflow`, `src/memory`, and related modules.
- **Bridge SDK**: the Claude Code compatibility/runtime path under `src/parity` and bridge-facing examples. It wraps or mirrors Claude Code behavior.

Clean SDK is a fully independent, standalone agent runtime whose implementation code should be completely open-sourceable. Its core agent behavior must live in this repository's Clean-owned code paths and must not depend on any closed-source or third-party agent runtime, including Claude Code, Bridge SDK, or any external agent CLI. This applies to subagents, tool loops, skills, memory/compact behavior, permissions, verification, orchestration, and runtime state management. Clean SDK may study or adapt ideas from Bridge SDK or other agents, but copied/adapted behavior must be reimplemented in Clean-owned modules. Clean SDK should be able to run directly against any OpenAI-compatible or Anthropic-compatible model provider through its own provider adapters.

When changing runtime behavior, state explicitly whether the change targets Clean SDK, Bridge SDK, or both. The Clean SDK must keep moving toward full Claude Code capability parity, including tool use, subagent delegation, skills, memory/compact behavior, permissions, and verification loops. Bridge SDK success is useful reference behavior, but it is not proof that Clean SDK has the same capability. Use Anthropic's official Claude Agent SDK / Claude Code SDK as an external baseline when benchmark or parity work needs a source-of-truth comparison beyond this repository's bridge wrapper.

`bin/actoviq-react.js` and `src/cli/actoviq-react.ts` are the Clean SDK interactive CLI surface. Preserve their readline/slash-command/streaming interaction behavior, but keep their agent runtime defaults aligned with `bench/agents/clean-sdk-runner.ts`: default Actoviq settings loading, `createActoviqCoreTools({ cwd })`, `permissionMode: 'bypassPermissions'`, and `maxToolIterations: 24`. Do not replace this CLI with a benchmark-only runner; benchmark-only session isolation, metrics, and trajectory logging should stay in `bench/`.

## Benchmark Harness Guidelines

Benchmark work lives under `bench/`. Use isolated copied workspaces, deterministic end-state graders, and repeated trials where practical. The agent prompt should contain the user-style task and relevant workspace context, not the hidden grader, gold fix, or a forced implementation recipe.

Keep harness internals out of the agent-visible workspace. Trial instruction, output, trajectory, and runner session files should live in a sibling temporary internal directory, and benchmark wrappers should clear `ACTOVIQ_BENCH_*` variables before starting the agent loop. Treat access to `.actoviq-bench`, `actoviq-bench-internal`, `goldCommand`, `bench/cases`, or `bench/reports` from agent tool calls as a benchmark policy failure.

Do not over-constrain models in benchmark tasks. Avoid requiring a specific plan format, tool order, command sequence, or code structure unless that constraint is part of the real task being measured. Prefer grading final observable state: tests pass, files contain expected content, workflow events are correct, or unsafe actions are denied.

Each benchmark case should declare a `runtimeTarget`: `clean-sdk`, `bridge-sdk`, `official-claude-sdk`, `parity`, or `external-agent`. Use `parity` when the purpose is to compare Clean SDK against Bridge SDK/Claude Code behavior. Keep reports and temporary workspaces generated-only; do not treat `bench/reports/` output as source.

Benchmark reports should preserve both deterministic scoring and behavior traces. Keep `passed` tied to final graders, and log metrics such as LLM request/turn count, tool call count, tool errors, subagent usage, skill usage, permission denials, token usage, cost, and event count whenever the runtime exposes them. Do not turn those metrics into prompt constraints; they are evidence for comparing general Claude Code-like agent capability.

Use `behaviorExpectations` for optional benchmark score signals such as minimum subagent calls, minimum skill use, or maximum tool errors. These expectations should affect the behavior score and comparison report only; they must not replace deterministic graders or force a prescribed ReAct script in the task prompt.

The complex benchmark suite should cover the local deterministic capability families already represented under `bench/cases/complex/`: coding, terminal/devops, workflow/subagent-oriented decomposition, skills, dialogue/policy/tool API, local docs/web research, memory/log debugging, and safety/prompt-injection resistance. Add new cases to these families before adding broad new benchmark categories.

Each trial may archive a JSONL trajectory under `bench/reports/<report>/trajectories/`. Trajectories should record observable events such as LLM requests, assistant messages, tool calls/results, subagent starts/results, skill loads, permission decisions, harness command verification, grader results, compaction, and errors. Do not store private chain-of-thought; keep trajectory entries to auditable summaries and structured metadata.

Use the existing commands when validating benchmark work:

- `npm run bench:smoke`: gold-mode harness smoke validation.
- `npm run bench:complex`: gold-mode validation for all complex local cases.
- `npm run bench:complex:clean`: real Clean SDK run over all complex cases.
- `npm run bench:complex:parity`: Clean SDK, Bridge SDK, and official Claude Agent SDK comparison over complex cases.
- `npm run bench:complex:parity:repeated`: three-trial complex parity run for variance checks.
- `npm run bench:adapt:example`: external-style manifest adapter smoke test.

Large external suites such as SWE-bench, Terminal-Bench, WebArena, and OSWorld should be integrated through `bench/adapters/` manifests rather than vendored wholesale. Keep those integrations opt-in unless the required external environment is small, deterministic, and practical for local CI.

## Local Planning Workflow

For any multi-step or long-running implementation, create or update a dated Markdown plan in `plan/` first, for example `plan/CLEAN_SDK_PARITY_TIMELINE_02Apr2026.md`. Keep the plan local-only; do not remove the Git/npm exclusions for `plan/`. Each plan should include completed work, remaining work, and a rough timeline for the unfinished items. Every completed step must be marked in the same file immediately after the work lands.
Use Markdown checkboxes for plan items and detailed sub-items: start unfinished work as `[ ]` and switch it to `[x]` as soon as that step or sub-step is completed.
