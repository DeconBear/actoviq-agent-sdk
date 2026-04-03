# Actoviq Agent SDK 中文教程

这是一套面向当前 SDK 的中文上手教程，目标是让你从零开始，逐步掌握 clean SDK、skills、tools、session、memory、MCP 和 bridge runtime 的使用方式。

推荐阅读顺序：

1. [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
3. [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
4. [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
5. [05-bridge-runtime.md](./05-bridge-runtime.md)
6. [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)

整个教程里有两条主线：

- `createAgentSdk()`：clean SDK 路线，适合绝大多数业务开发和二次封装。
- `createActoviqBridgeSdk()`：bridge 路线，适合需要 runtime 原生 tools / skills / introspection 的场景。

如果你想最快跑起来：

1. 先看 [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. 运行 `npm run example:quickstart`
3. 再运行 `npm run example:actoviq-interactive-agent`，体验带流式输出和工具调用的终端交互示例
