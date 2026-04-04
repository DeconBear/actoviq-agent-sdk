# Actoviq Agent SDK Tutorial

This tutorial is a practical, step-by-step guide to the current SDK. It is organized so you can start with a working chat bot, then add tools, skills, sessions, MCP, memory, and runtime bridge features as needed.

Recommended reading order:

1. [01-setup-and-quickstart.md](./01-setup-and-quickstart.md)
2. [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
3. [03-tools-permissions-skills-mcp.md](./03-tools-permissions-skills-mcp.md)
4. [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
5. [05-bridge-runtime.md](./05-bridge-runtime.md)
6. [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
7. [07-build-a-complete-clean-agent.md](./07-build-a-complete-clean-agent.md)

Two execution paths matter throughout this guide:

- `createAgentSdk()` is the clean SDK path. Use it for most product and application code.
- `createActoviqBridgeSdk()` is the runtime bridge path. Use it when you need runtime-native built-ins, runtime skills, or runtime introspection.

If you only want to get moving quickly:

1. Read [01-setup-and-quickstart.md](./01-setup-and-quickstart.md).
2. Run `npm run example:quickstart`.
3. Then run `npm run example:actoviq-interactive-agent` for a ready-to-use interactive demo with streaming output and tool calls.

If you want a full clean-SDK project walkthrough, jump to:

- [07-build-a-complete-clean-agent.md](./07-build-a-complete-clean-agent.md)

Advanced notes:

- `buddy` and `dream` are documented inside the existing advanced chapters instead of being split into separate nav pages.
- See [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md) for both.
