# Actoviq Agent SDK 中文教程

这是一套面向当前 SDK 的中文上手教程，目标是让你从零开始，逐步掌握 Hadamard SDK、providers、tools、session、memory、MCP 与 orchestration。

> 最近校对：2026-07-29。支持 Node.js `^22.13.0 || ^24.0.0`。

开始前先选择路线：

- `createAgentSdk()`：交互产品和兼容入口，自带 sessions、skills、memory、MCP 与核心工具。
- `actoviq-agent-sdk/core|providers|runtime|...`：新应用优先使用的模块化 Runtime 入口，边界更明确。

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
2. 运行 `npm run example:actoviq-quickstart`

如果你想完整做一个真正可用的 Hadamard SDK 项目，推荐直接阅读：
- [06-build-a-complete-clean-agent.md](./06-build-a-complete-clean-agent.md)

如果你特别关心 advanced 能力：

1. `buddy` 和 `dream` 不会单独做成导航页
2. 它们被放进了更合适的章节中：
   - `buddy`：见 [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
   - `dream`：见 [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md) 和 [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)

01–07 同时解释兼容路线和模块化 Runtime 路线。Bridge 只用于外部 CLI 兼容，不是 Hadamard SDK 的运行依赖。
