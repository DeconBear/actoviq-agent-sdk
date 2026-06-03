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

When changing runtime behavior, state explicitly whether the change targets Clean SDK, Bridge SDK, or both. The Clean SDK must keep moving toward full Claude Code capability parity, including tool use, subagent delegation, skills, memory/compact behavior, permissions, and verification loops. Bridge SDK success is useful reference behavior, but it is not proof that Clean SDK has the same capability. Use Anthropic's official Claude Agent SDK / Claude Code SDK as an external baseline when benchmark or parity work needs a source-of-truth comparison beyond this repository's bridge wrapper.

## Benchmark Harness Guidelines

Benchmark work lives under `bench/`. Use isolated copied workspaces, deterministic end-state graders, and repeated trials where practical. The agent prompt should contain the user-style task and relevant workspace context, not the hidden grader, gold fix, or a forced implementation recipe.

Do not over-constrain models in benchmark tasks. Avoid requiring a specific plan format, tool order, command sequence, or code structure unless that constraint is part of the real task being measured. Prefer grading final observable state: tests pass, files contain expected content, workflow events are correct, or unsafe actions are denied.

Each benchmark case should declare a `runtimeTarget`: `clean-sdk`, `bridge-sdk`, `official-claude-sdk`, `parity`, or `external-agent`. Use `parity` when the purpose is to compare Clean SDK against Bridge SDK/Claude Code behavior. Keep reports and temporary workspaces generated-only; do not treat `bench/reports/` output as source.

Benchmark reports should preserve both deterministic scoring and behavior traces. Keep `passed` tied to final graders, and log metrics such as LLM request/turn count, tool call count, tool errors, subagent usage, skill usage, permission denials, token usage, cost, and event count whenever the runtime exposes them. Do not turn those metrics into prompt constraints; they are evidence for comparing general Claude Code-like agent capability.

## Local Planning Workflow

For any multi-step or long-running implementation, create or update a dated Markdown plan in `plan/` first, for example `plan/CLEAN_SDK_PARITY_TIMELINE_02Apr2026.md`. Keep the plan local-only; do not remove the Git/npm exclusions for `plan/`. Each plan should include completed work, remaining work, and a rough timeline for the unfinished items. Every completed step must be marked in the same file immediately after the work lands.
Use Markdown checkboxes for plan items and detailed sub-items: start unfinished work as `[ ]` and switch it to `[x]` as soon as that step or sub-step is completed.
