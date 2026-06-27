# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [Chinese](./README-zh.md)

Documentation site: https://deconbear.github.io/actoviq-agent-sdk/

Actoviq Agent SDK is an experimental TypeScript SDK for building multi-tool, multi-session agents with a clean-first public API, MCP integration, and memory helpers.

This project is inspired by excellent agent projects and runtimes including Claude Code, Codex, Deepagents, and similar work in the ecosystem. Actoviq remains an independent project with its own public SDK surface and documentation.

## Highlights

- **Desktop GUI (`actoviq-gui`)** — an Electron chat UI: streamed transcript with markdown + copyable code, conversation history on resume, command palette, settings, and per-tool permission prompts. Security-hardened (loopback Host/Origin checks + per-process token + CSP)
- **Model Team** — read-only advisory teams the agent invokes: `panel-analysis` (parallel investigation + optional primary-driven convergence) and `reviewer` (reports only verifiable issues). A centralized runtime (`src/team/teamRuntime.ts`) runs every member with a stable identity (id/name/role), streamed `TeamEvent`s, and structured `memberStatuses`; per-member provider config, $ENV_VAR apiKey resolution, global AgentPool
- **Model Router / Leader-Dispatch** — a `/model` layer (not a team): a leader classifies each turn and dispatches it to the best specialist route (model/provider), then runs normally. Routes carry `role`/`description`, a built-in `dispatch` profile ships out of the box, profiles live in `~/.actoviq/routers/`, and the chosen executor may itself convene a team
- **Dynamic Workflows** — JS script-based multi-agent orchestration with `agent()`/`parallel()`/`pipeline()` primitives, sandboxed runtime, schema enforcement
- **Worktree Tools** — `EnterWorktree`/`ExitWorktree` with stack-based cwd, `.worktreeinclude`, PR checkout, hooks for non-git VCS
- **TavilySearch** — AI-optimized web search, pure TypeScript, auto key detection
- **Standard Benchmark** — Self-contained framework with DeepSeek judge, HTML dashboard, 4-agent comparison (Hadamard/Bridge/Official)
- **TUI/REPL**: selection pickers for `/team`, `/workflows`, `/worktree`; `/permissions` presets (read-only / workspace / full); `@` file completion; and a live context-usage + active-mode status line

This repository is still under active development. APIs and runtime behavior may continue to evolve. Issues and pull requests are very welcome.

## Install

```bash
npm install actoviq-agent-sdk zod
```

For local examples, place your config at:

```text
~/.actoviq/settings.json
```

You can also preload a custom JSON file with `loadJsonConfigFile(...)`.

## Quick Start

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

// Default: Anthropic protocol
const sdk = await createAgentSdk();

// Or use OpenAI / OpenAI-compatible APIs (DeepSeek, vLLM, etc.)
const sdk = await createAgentSdk({
  provider: 'openai',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
});

try {
  const result = await sdk.run('Introduce yourself in one short sentence.');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

Run the repository examples with:

```bash
npm run example:actoviq-quickstart
npm run example:actoviq-agent-helpers
```

## CLI REPL

After installing the package, you can start an interactive scrollback-mode REPL directly from the terminal:

```bash
npx actoviq-react [work-dir]
```

This launches a readline-based interactive agent with:
- Real-time streaming output in the main terminal buffer (native scrollback)
- Tab completion for slash commands, including session model, permission, compact, and resume controls
- Command history via ↑↓ arrow keys
- Ctrl+C to abort the current request, press twice to exit

**Note:** `actoviq-react` is a lightweight scrollback REPL, **not a full-featured TUI**. It does not use an alternate screen buffer, ScrollBox, or rich terminal rendering. It is designed for quick interaction and debugging. For the full terminal UI, use `actoviq-tui` below.

## Terminal UI (TUI)

`actoviq-tui` is the full terminal UI for the Hadamard SDK, modeled on Claude Code's REPL design: the transcript prints into native scrollback while a redrawable bottom region hosts the status line, a Claude-style prompt bar, the slash-command menu, and permission dialogs.

```bash
npx actoviq-tui [work-dir] [options]

# Options
#   --config <path>            Load a specific Actoviq settings JSON file
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)
#   --model <model>            Override the configured model
#   --resume <session-id>      Resume a stored Hadamard SDK session
#   --continue                 Continue the most recently updated session
```

Features:

- **Streaming transcript in native scrollback** — assistant text, `⏺ Tool(args)` calls, and `⎿ ✓/✗` result lines flush into the normal terminal buffer; scrollback and copy/paste work as usual.
- **Live status line** — spinner, elapsed time, tool count, and the active tool while the agent works, over an always-visible mode line (model · permission preset · effort · active team) that shows **context usage as a percentage of the window** and turns yellow then red as it fills.
- **Claude-style prompt bar** — type `\` then `Enter` (or `Ctrl+J`) for a newline; `↑`/`↓` walk input history; the caret renders inline.
- **Slash-command menu** — type `/` to open a filtered menu (`↑↓` select, `Tab` complete, `Enter` run). `/resume` opens a searchable project-session picker, while `/resume <session-id>` still resumes directly.
- **`@` file completion** — type `@` to open a workspace file picker filtered by the partial path; `↑↓` select, `Tab`/`Enter` insert it. The list is git-aware (tracked + untracked, `.gitignore`-honoring) and refreshes after each run.
- **Team / workflow / worktree pickers** — `/team` activates a saved Model Team (or "no team") as a tool the agent may call; `/workflows` runs a saved dynamic workflow; `/worktree` enters, exits, or lists git worktrees. Direct forms still work (`/team ask <name> <prompt>`, `/workflows run <name>`, `/worktree enter <name>`).
- **Permission presets** — `/permissions` switches between **read-only**, **workspace-access** (auto-approve edits inside the workspace), and **full-access** (bypass) presets without restarting.
- **Runtime catalogs** — `/skills`, `/agents`, `/mcp`, and `/plugins` browse the Hadamard SDK capabilities visible to the current workspace; `/help` provides a searchable command reference.
- **Model and effort controls** — `/model` opens a model picker, `/model config` edits the provider, masked API key, base URL, and `min`/`medium`/`max` model tiers, and `/effort` selects `low`, `medium`, `high`, `max`, or automatic provider behavior.
- **Dream controls** — `/dream` opens a run/status picker; `/dream run` and `/dream status` remain available for direct use.
- **Mid-run steering** — keep typing while the agent works and press `Enter`: the message is queued and injected into the very next model request (shown as `⧗ queued`).
- **Permission dialogs** — with `--permission-mode default`, mutating tools pause for an approve / always-allow / deny dialog. Always-allow choices are stored with the session and restored on resume.
- **Interrupts** — `Esc` aborts the current run; `Ctrl+C` clears the input (twice quickly exits); `Ctrl+D` exits on an empty prompt.
- **Context management built in** — the Hadamard SDK auto-compacts long sessions mid-run and reactively recovers when a provider rejects an oversized prompt; compactions surface as `∿ context compacted` notices.

Both CLIs share the same Hadamard SDK runtime defaults (Actoviq settings from `~/.actoviq/settings.json`, core tools, `bypassPermissions`, uncapped tool iterations) and run against any Anthropic-compatible or OpenAI-compatible provider.

By default, Hadamard SDK sessions are scoped to the current workspace under `~/.actoviq/projects/<workspace-key>`. Explicit `sessionDirectory` settings still take precedence.

Model tiers are provider-neutral aliases. Configure them with `ACTOVIQ_DEFAULT_MIN_MODEL`, `ACTOVIQ_DEFAULT_MEDIUM_MODEL`, and `ACTOVIQ_DEFAULT_MAX_MODEL`, then use `min`, `medium`, or `max` anywhere a model can be selected.

## Desktop GUI (`actoviq-gui`)

A local Electron desktop chat UI for the Hadamard SDK.

```bash
npx actoviq-gui [work-dir] [options]

# Options
#   --port <port>              Internal port to bind (default: 4174, auto-fallback if busy)
#   --config <path>            Load a specific Actoviq settings JSON file
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)
#   --model <model>            Override the configured model
#   --resume <session-id>      Resume a stored session
#   --continue                 Resume the most recent stored session
```

It opens an Electron window backed by a localhost-only HTTP server. Features:

- **Streamed transcript** with markdown rendering and copyable code blocks, plus live tool-call cards
- **Conversation history on resume** — opening or switching a chat replays its stored messages
- **Command palette + slash commands**, settings (provider / model / keys / appearance), workspace switching, and empty-chat cleanup
- **Per-tool permission prompts** (queued so concurrent requests don't collide) and a token-usage readout

**Security model:** the internal API is reachable only from loopback (Host + Origin allowlist, which defeats DNS-rebinding / CSRF) and requires a per-process token; the page ships a strict Content-Security-Policy. Electron runs with `sandbox`, `contextIsolation`, and no `nodeIntegration`.

> `electron` and `bun` are **optional** dependencies — installed only if you use the GUI / bridge runtime (the bridge's `directCli` mode needs no `bun` either). The core SDK does not require them.

## Developer notes

- **Build before launching the CLIs/GUI:** `npm run build` (clean + `tsc`). Type-check only with `npm run typecheck`; run the suite with `npm test -- --run`.
- **Team behavior is centralized:** extend teams through `src/team/teamRuntime.ts` (`runMemberAgent` / `buildMemberIdentities` / `preflightMember`) rather than duplicating per-mode logic. Observe a run via `team.ask(prompt, signal, { onEvent })` and inspect `result.memberStatuses` / `result.incompleteReason`.
- **Router profiles are leader/dispatch configs:** a `RouterProfile` is a leader (`routerModel`) + a roster of specialist `routes` (each with `when` and optional `role` / `description`). `BUILT_IN_ROUTER_PROFILES` ships a ready-made `dispatch` profile; a user file of the same name in `.actoviq/routers/` shadows it.
- **`CLAUDE.md` is intentionally git-ignored** in this repo — keep contributor-facing docs here in the README (or under `docs/`), not in `CLAUDE.md`.

## Tutorials

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- Chinese tutorial: [docs/zh/README.md](./docs/zh/README.md)
- GitHub Pages docs site:
  - https://deconbear.github.io/actoviq-agent-sdk/

Start with these examples:

- [examples/actoviq-quickstart.ts](./examples/actoviq-quickstart.ts)
- [examples/actoviq-workflow.ts](./examples/actoviq-workflow.ts)
- [examples/actoviq-agent-helpers.ts](./examples/actoviq-agent-helpers.ts)

## Contributing

Contributions are welcome. If you spot a bug or a documentation gap, please open an issue or submit a pull request.

Licensed under the [MIT License](./LICENSE).
