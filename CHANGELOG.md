# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, with automated updates from GitHub Releases.

## v0.4.0 - 2026-06-15

### Features

- **Subagent infrastructure**: `Agent`/`Task` tool with Task compatibility alias, persistent sessions, and `SendMessage` continuation
- **Background agents**: automatic completion notifications, progress tracking, cancellation, and lifecycle reconciliation
- **Markdown agent definitions**: user-level (`~/.actoviq/agents/`) and project-level (`.actoviq/agents/`) `.md` files with tool/skill/permission/MCP/effort controls
- **Worktree isolation**: `isolation: "worktree"` for parallel agents editing overlapping files; dirty worktrees retained, clean ones auto-removed
- **Nested delegation controls**: configurable depth limit (`maxSubagentDepth`), fanout limit (`maxSubagentFanout`), and per-definition allowed agents
- **Built-in agent definitions**: Explore, Plan, and general-purpose agents with Claude Code-compatible profiles
- **Windows Bash tool**: now uses Git Bash for POSIX commands on Windows
- **TUI**: full-screen terminal UI (`actoviq-tui`) with session management, permission mode switching, and provider configuration
- **Model tiers**: `min`/`medium`/`max` tier resolution with `ACTVIQ_DEFAULT_{TIER}_MODEL` env vars
- **Enhanced Agent tool prompt**: Claude Code-level subagent guidance (foreground/background, parallel delegation, "never delegate understanding")

### Bug Fixes

- `close()` now tolerates individual cleanup failures instead of bailing on first error
- `isGitWorkspaceDirty`: added 10s timeout, returns false on error to prevent worktree leaks
- Background task `cancel()`: re-reads store after abort to prevent TOCTOU race with terminal state
- `forwardStreamResult`: captures both pump and result errors instead of silently losing one
- Agent definition loader: logs a warning for malformed `.md` files instead of silently skipping them
- `encodeActoviqProjectPath` test made platform-aware (was hardcoded to Windows paths)

### Benchmark

- New cases: `workflow-agent-continuation` (SendMessage + background), `workflow-multi-module-parallel` (3-way parallel subagents)
- Complex suite: 10/10 all three runtimes pass (Clean 0.993, Bridge 0.992, Official 0.960)
- Long suite: 4/5 Clean and Bridge, 5/5 Official (`release-train-reconciliation` remains systemic weak point)
- Multi-module-parallel: Clean 1.000 (3 parallel background subagents), Bridge 0.996, Official 0.953

### TUI Branding

- Display name changed from `Actoviq TUI` to `Hadamard Agent` (3 visible strings; all internal names, env vars, and config paths unchanged)

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
