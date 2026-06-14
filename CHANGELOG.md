# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, with automated updates from GitHub Releases.

## v0.4.0 - 2026-06-14

### What's Changed

* feat: complete Clean SDK subagent parity with bug fixes and multi-module benchmark by @DeconBear in https://github.com/DeconBear/actoviq-agent-sdk/pull/1

### New Contributors

* @DeconBear made their first contribution in https://github.com/DeconBear/actoviq-agent-sdk/pull/1

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.3.1...v0.4.0

## v0.3.1 - 2026-06-11

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.3.0...v0.3.1

## v0.3.0 - 2026-05-11

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/commits/v0.3.0

## v0.2.0 - 2026-05-08

### Breaking Changes

- **`WorkflowBuilder.step()`** signature changed from 5 params `(id, name, description, prompt, opts?)` to 4 params `(id, description, prompt, opts?)`. The `name` field is removed — `description` now serves as the display name.
- **`WorkflowStepDefinition`** removed `name` field. Use `description` for human-readable display names.

### Features

- **Workflow orchestration engine** with DAG execution, topological sort, and parallel step execution
- **Builder DSL** (`sdk.workflow.define(...).step(...).run()`) and **JSON API** dual design paths
- **Agent-orchestrated workflows**: Agent designs and executes workflow JSON via a `run_workflow` custom tool
- **Tool registry pattern** (`sdk.getTool(name)`) enabling JSON-defined workflows to reference tools by name
- **Step mode**: `'react'` (default, full tool loop) or `'single'` (no tool use, `tool_choice: none`)
- **Variable interpolation** in step prompts: `$steps.<id>.text`, `$steps.<id>.toolCalls`, `$PARAM_NAME`
- **`parallel()`** and **`race()`** primitives for concurrent task execution
- **`SessionManager`** with idle timeout, auto-prune, stats, and lifecycle management
- **Session checkpoints**: `saveCheckpoint()`, `restoreCheckpoint()`, `listCheckpoints()`, `deleteCheckpoint()`
- **OpenAI protocol compatibility**: new `provider: 'openai'` option in `createAgentSdk()`. Use OpenAI, DeepSeek, or any OpenAI-compatible API with the same SDK surface. Automatic Anthropic ↔ OpenAI format translation.
- **Alignment with Claude Code architecture**: tool self-declaration (isReadOnly/isDestructive/checkPermissions), canUseTool callback, compaction layered defense + circuit breaker, post-compaction context restoration, stop hooks system
- Session lifecycle management: idle timeout, prune by age/status, close idle

### Docs

- Added agent-orchestrated workflow section (1.2) to EN and ZH tutorial docs
- Documented OpenAI protocol configuration in setup/quickstart (EN + ZH)

### Examples

- Added `workflow-annotated.ts` — annotated walkthrough of every API parameter
- Added `workflow-agent-orchestration.ts` — Agent autonomously designs and executes workflows
- Added `actoviq-platform.ts` — consolidated workspaces + swarm + session memory + dream
- Removed 8 redundant examples (buddy, computer-use, dream, memory, session-memory, skills, swarm, workspaces)
- 12 focused examples remaining

### Fixes

- 18 bugs across provider layer, runtime, and workflow engine
- Missing public API exports (trackRecentFile, resolveActoviqStopHooks, etc.)

### Internal

- Fixed regex for hyphenated step IDs in variable interpolation (`\w+` → `[\w-]+`)
- Defensive `?.` checks on optional `dependsOn` and `steps` fields across workflow engine
- `getTool()` public method on `ActoviqAgentClient` for tool registry lookup

## v0.1.12 - 2026-05-06

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.11...v0.1.12

## v0.1.11 - 2026-04-04

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.9...v0.1.11

## v0.1.10 - 2026-04-03

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.9...v0.1.10

## v0.1.9 - 2026-04-03

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.8...v0.1.9

## v0.1.8 - 2026-04-03

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.7...v0.1.8

## v0.1.7 - 2026-04-02

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.6...v0.1.7

## v0.1.6 - 2026-04-02

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.5...v0.1.6

## v0.1.5 - 2026-04-02

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.4...v0.1.5

## v0.1.4 - 2026-04-02

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.3...v0.1.4

## v0.1.3 - 2026-04-01

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.2...v0.1.3

## v0.1.2 - 2026-04-01

**Full Changelog**: https://github.com/DeconBear/actoviq-agent-sdk/compare/v0.1.1...v0.1.2
