# Actoviq Agent SDK 中文教程

这是一套面向当前 SDK 的中文上手教程，目标是让你从零开始，逐步掌握 clean SDK、skills、tools、session、memory、MCP 和兼容 bridge runtime 的使用方式。

推荐阅读顺序：
1. [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
3. [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
4. [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
5. [05-bridge-runtime.md](./05-bridge-runtime.md)
6. [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
7. [07-build-a-complete-clean-agent.md](./07-build-a-complete-clean-agent.md)

如果你想最快跑起来：
1. 先看 [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. 运行 `npm run example:quickstart`
3. 再运行 `npm run example:actoviq-interactive-agent`

如果你想完整做一个真正可用的 clean SDK 项目，推荐直接阅读：
- [07-build-a-complete-clean-agent.md](./07-build-a-complete-clean-agent.md)

如果你特别关心 advanced 能力：

1. `buddy` 和 `dream` 不会单独做成导航页
2. 它们被放进了更合适的章节中：
   - `buddy`：见 [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
   - `dream`：见 [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md) 和 [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)

整个教程里有两条主线：
- `createAgentSdk()`：clean SDK 主路径，适合绝大多数业务开发和二次封装
- `createActoviqBridgeSdk()`：兼容路径，适合需要研究或接入现有 runtime 行为的场景
