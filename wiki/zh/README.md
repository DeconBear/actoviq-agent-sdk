# Hadamard Agent SDK — 仓库 Wiki（中文版）

面向人类读者和 AI 智能体的内部设计文档库。
阅读本文档可以理解仓库的构建方式、设计理念，以及在新增功能或审查设计缺陷时应该从哪里入手。

## 模块索引

| # | 页面 | 模块 | 对应源文件 |
|---|---|---|---|
| 01 | [入口与总览](01-entry-and-overview.md) | 公开 API、双 SDK 模型 | `src/index.ts` |
| 02 | [配置管道](02-config-pipeline.md) | 配置解析、模型分级 | `src/config/*` |
| 03 | [ReAct 循环](03-react-loop.md) | 核心 agent 执行引擎 | `src/runtime/conversationEngine.ts` |
| 04 | [Agent 客户端](04-agent-client.md) | 中央编排器类 | `src/runtime/agentClient.ts` |
| 05 | [会话系统](05-session-system.md) | 会话生命周期、检查点 | `src/runtime/agentSession.ts`, `src/storage/sessionStore.ts` |
| 06 | [子代理系统](06-subagent-system.md) | Agent/Task 委派、后台任务 | `src/runtime/actoviqAgents.ts`, `src/runtime/actoviqBackgroundTasks.ts` |
| 07 | [工具系统](07-tool-system.md) | tool() 工厂、核心/文件/Shell 工具 | `src/runtime/tools.ts`, `src/tools/*` |
| 08 | [Provider 层](08-provider-layer.md) | ModelApi、Anthropic/OpenAI 适配器 | `src/runtime/actoviqModelApi.ts`, `src/provider/*` |
| 09 | [上下文注入](09-context-injection.md) | 系统提示词、通知、压缩 | `src/runtime/agentClient.ts:2105-2800` |
| 10 | [权限系统](10-permissions.md) | 工具权限决策管道 | `src/runtime/actoviqPermissions.ts` |
| 11 | [钩子系统](11-hooks-system.md) | 生命周期钩子 | `src/hooks/actoviqHooks.ts` |
| 12 | [记忆与梦境](12-memory-and-dream.md) | 记忆整合、Dream 过程 | `src/memory/*` |
| 13 | [工作流引擎](13-workflow-engine.md) | DAG 工作流、拓扑排序 | `src/workflow/*` |
| 14 | [Swarm 系统](14-swarm-system.md) | 多 agent 协作、邮箱模式 | `src/swarm/*` |
| 15 | [工作区与 Worktree](15-workspace-and-worktrees.md) | Git worktree 管理 | `src/workspace/*` |
| 16 | [MCP 集成](16-mcp-integration.md) | MCP 连接管理 | `src/mcp/*` |
| 17 | [CLI 与 TUI](17-cli-and-tui.md) | REPL、终端 UI、斜杠命令 | `src/cli/*`, `src/tui/*` |
| 18 | [Bridge SDK 与兼容](18-bridge-sdk-and-parity.md) | 桥接封装、兼容层 | `src/parity/*` |
| 19 | [Benchmark 测试框架](19-benchmark-harness.md) | Benchmark 运行器、用例、评分 | `bench/*` |
| 20 | [耦合与尖锐边缘](20-coupling-and-sharp-edges.md) | 跨模块关注点、已知问题 | (跨模块) |
| 21 | [Model Team 多模型协作](21-model-team.md) | Panel/Router/Discussion/Executor-Reviewer | `src/team/*` |
| 22 | [Tavily Search 与网络搜索](22-tavily-and-search.md) | AI 优化搜索、Tavily 集成 | `src/tools/tavilySearch.ts` |

## 仓库速览

| 属性 | 值 |
|---|---|
| 语言 | TypeScript (ESM), Zod v4 |
| 核心类 | `ActoviqAgentClient` (`src/runtime/agentClient.ts`, ~3820 行) |
| ReAct 引擎 | `executeConversation()` (`src/runtime/conversationEngine.ts`) |
| 存储 | `~/.actoviq/projects/<hash>/` 下的 JSON 文件 |
| CodeGraph | `.codegraph/`, 260 文件, ~4K 节点, ~11K 边 |

## 文档体系

- `docs/en/` / `docs/zh/` — 面向用户的上手指南
- `wiki/` — 内部设计参考（本目录），含英文原版
- `wiki/zh/` — 中文翻译版（本目录）
- `plan/` — 有时限的实现计划
- `CLAUDE.md` / `AGENTS.md` — AI agent 会话指令
