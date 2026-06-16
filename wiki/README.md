# Hadamard Agent SDK — Repository Wiki

Internal design documentation. Each page covers one module across three
dimensions: **architecture** (why it exists), **module design** (how it
connects), and **code details** (how it's implemented).

## Module Index

| # | Page | Module | Files |
|---|---|---|---|
| 01 | [Entry & Overview](01-entry-and-overview.md) | Public API, two-SDK model | `src/index.ts` |
| 02 | [Config Pipeline](02-config-pipeline.md) | Settings resolution, model tiers | `src/config/*` |
| 03 | [ReAct Loop](03-react-loop.md) | Core agent execution engine | `src/runtime/conversationEngine.ts` |
| 04 | [Agent Client](04-agent-client.md) | Central orchestrator class | `src/runtime/agentClient.ts` |
| 05 | [Session System](05-session-system.md) | Session lifecycle, checkpoints | `src/runtime/agentSession.ts`, `src/storage/sessionStore.ts` |
| 06 | [Subagent System](06-subagent-system.md) | Agent/Task delegation, background tasks | `src/runtime/actoviqAgents.ts`, `src/runtime/actoviqBackgroundTasks.ts` |
| 07 | [Tool System](07-tool-system.md) | tool() factory, core/file/shell tools | `src/runtime/tools.ts`, `src/tools/*` |
| 08 | [Provider Layer](08-provider-layer.md) | ModelApi, Anthropic/OpenAI adapters | `src/runtime/actoviqModelApi.ts`, `src/provider/*` |
| 09 | [Context Injection](09-context-injection.md) | System prompt, notifications, compaction | `src/runtime/agentClient.ts:2105-2800`, `src/runtime/actoviqCompact.ts` |
| 10 | [Permissions](10-permissions.md) | Tool permission decision pipeline | `src/runtime/actoviqPermissions.ts` |
| 11 | [Hooks System](11-hooks-system.md) | Lifecycle hooks (session/run/stop) | `src/hooks/actoviqHooks.ts` |
| 12 | [Memory & Dream](12-memory-and-dream.md) | Memory consolidation, dream process | `src/memory/*` |
| 13 | [Workflow Engine](13-workflow-engine.md) | DAG workflow, topological sort | `src/workflow/*` |
| 14 | [Swarm System](14-swarm-system.md) | Multi-agent swarm, mailbox pattern | `src/swarm/*` |
| 15 | [Workspace & Worktrees](15-workspace-and-worktrees.md) | Git worktree management, temp directories | `src/workspace/*` |
| 16 | [MCP Integration](16-mcp-integration.md) | MCP connection management | `src/mcp/*` |
| 17 | [CLI & TUI](17-cli-and-tui.md) | REPL, terminal UI, slash commands | `src/cli/*`, `src/tui/*` |
| 18 | [Bridge SDK & Parity](18-bridge-sdk-and-parity.md) | Bridge wrappers, compatibility | `src/parity/*` |
| 19 | [Benchmark Harness](19-benchmark-harness.md) | Benchmark runner, cases, grading | `bench/*` |
| 20 | [Coupling & Sharp Edges](20-coupling-and-sharp-edges.md) | Cross-cutting concerns, known issues | (cross-module) |
| 21 | [Model Team](21-model-team.md) | Panel/Router/Discussion/Executor-Reviewer | `src/team/*` |
| 22 | [Tavily & Web Search](22-tavily-and-search.md) | AI-optimized search, Tavily integration | `src/tools/tavilySearch.ts` |

## Repo at a Glance

| Attribute | Value |
|---|---|
| Language | TypeScript (ESM), Zod v4 |
| Core class | `ActoviqAgentClient` (`src/runtime/agentClient.ts`, ~3820 lines) |
| ReAct engine | `executeConversation()` (`src/runtime/conversationEngine.ts`) |
| Storage | JSON files under `~/.actoviq/projects/<hash>/` |
| CodeGraph | `.codegraph/`, 260 files, ~4K nodes, ~11K edges |

## Relationship to Other Docs

- `docs/en/` / `docs/zh/` — user-facing tutorials
- `wiki/` — internal design reference (this directory)
- `plan/` — time-bound implementation plans
- `CLAUDE.md` / `AGENTS.md` — AI agent session instructions
