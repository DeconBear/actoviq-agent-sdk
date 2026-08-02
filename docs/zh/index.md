# Hadamard Agent SDK 中文教程

这是一套面向当前 SDK 的中文上手教程，目标是让你从零开始，逐步掌握 Hadamard SDK、providers、tools、session、memory、MCP 与 orchestration。

> 最近校对：2026-07-29。支持 Node.js `^22.13.0 || ^24.0.0`。

## 先选择入口

Hadamard 现在有两条都受支持、但用途不同的 API 路线：

| 路线 | 入口 | 适用场景 |
|---|---|---|
| 交互/兼容路线 | package root 的 `createAgentSdk()` | GUI、TUI、CLI、现有 0.x 应用，以及希望直接获得 sessions、skills、memory、MCP 和核心工具的应用 |
| 模块化 Runtime 路线 | `/core`、`/providers`、`/runtime` 等职责 subpath | 新 SDK 集成、需要明确 provider/runtime/storage/orchestration 边界的应用 |

Hadamard SDK 的核心实现完全独立。需要兼容 Claude、Codex、Pi 等外部 CLI 时，再阅读 [Bridge Runtime 附录](./bridge-runtime.md)。

推荐阅读顺序：
1. [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
3. [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
4. [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
5. [05-testing-troubleshooting-cheatsheet.md](./05-testing-troubleshooting-cheatsheet.md)
6. [06-build-a-complete-clean-agent.md](./06-build-a-complete-clean-agent.md)
7. [07-workflow-orchestration.md](./07-workflow-orchestration.md)
8. [Bridge Runtime 附录](./bridge-runtime.md)

如果你想最快跑起来：
1. 先看 [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. 运行 `npm run example:hadamard-quickstart`
3. 或运行 `npx hadamard-tui [工作目录]` 启动统一的交互式终端界面。

如果你想完整做一个真正可用的 Hadamard SDK 项目，推荐直接阅读：
- [06-build-a-complete-clean-agent.md](./06-build-a-complete-clean-agent.md)

01–07 会同时标明两条路线。第一次使用可以从 `createAgentSdk()` 跑通，再按应用边界迁移到模块化 Runtime。
