# Actoviq Agent SDK 中文教程

这是一套面向当前 SDK 的中文上手教程，目标是让你从零开始，逐步掌握 Hadamard SDK、skills、tools、session、memory 和 MCP 的使用方式。

推荐阅读顺序：
1. [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
3. [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
4. [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
5. [05-testing-troubleshooting-cheatsheet.md](./05-testing-troubleshooting-cheatsheet.md)
6. [06-build-a-complete-clean-agent.md](./06-build-a-complete-clean-agent.md)
7. [07-workflow-orchestration.md](./07-workflow-orchestration.md)
8. [08-sdk-architecture-audit-and-optimization-plan.md](./08-sdk-architecture-audit-and-optimization-plan.md)
9. [09-sdk-v2-migration-guide.md](./09-sdk-v2-migration-guide.md)
10. [10-support-security-semver-and-failure-model.md](./10-support-security-semver-and-failure-model.md)
11. [11-json-v1-to-sqlite-migration-runbook.md](./11-json-v1-to-sqlite-migration-runbook.md)
12. [12-sdk-1.0-implementation-and-verification-report.md](./12-sdk-1.0-implementation-and-verification-report.md)

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

01–07 保留 `createAgentSdk()` 兼容教程，适合维护 0.x 应用；新项目从 08–11 的架构与迁移说明开始，使用 `/core`、`/providers`、`/runtime` 等 1.0 职责 subpath。兼容 façade 在整个 1.x 继续支持。
