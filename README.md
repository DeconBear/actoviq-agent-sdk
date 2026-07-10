# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [Chinese](./README-zh.md)

Documentation site: https://deconbear.github.io/actoviq-agent-sdk/

**Actoviq** is an agent team platform — a TypeScript framework for composing multiple AI agents, runtimes, and providers into collaborative multi-agent systems. It grew out of a programmable agent SDK but now targets the **multi-agent, multi-runtime state management** and **model team collaboration** space: coordinating specialized models, routing turns across providers, and orchestrating agent swarms with shared context.

Inspired by Claude Code, Codex, Deepagents, and the broader agent ecosystem. Actoviq remains independent with its own public surface and documentation.

## Vision

- **Multi-agent**: subagent delegation (Task tool), panel-analysis teams, reviewer-auditor pairs, dynamic workflows — agents collaborating, not just a single loop.
- **Multi-runtime state management**: bridge configs let you pre-configure multiple backends (anthropic / openai / any-compatible) with apiKey + baseURL + model, switch by name mid-session, and the conversation context survives the switch (same session object, same transcript).
- **Model team collaboration**: leaders dispatch to specialists (`/model router`), panel members investigate in parallel with structured convergence, reviewers report only verifiable issues — teams as first-class tools the agent invokes.

## Highlights

- **Model Team** — `panel-analysis` (parallel investigation + convergence) and `reviewer` (verifiable-issues-only auditor). Centralized runtime (`src/team/teamRuntime.ts`) per stable member identity, streamed `TeamEvent`s, per-member provider config, `$ENV_VAR` apiKey resolution, global AgentPool.
- **Model Router / Leader-Dispatch** — a leader classifies each turn and dispatches it to the best specialist route (any model/provider), runs normally, and the executor may itself convene a team. Profiles in `~/.actoviq/routers/`.
- **Dynamic Workflows** — JS script-based multi-agent orchestration: `agent()`/`parallel()`/`pipeline()` primitives, sandboxed runtime, schema enforcement.
- **Bridge (named connection configs)** — in-process runtime switching: pre-configure `anthropic`/`openai` backends with name + apiKey + baseURL + model, switch by name mid-session, multi-turn context survives (same session). `/bridge config` single-page editor; `/bridge` lists saved configs; per-config usage tracking in `/cost`.
- **Desktop GUI (`actoviq-gui`)** — Electron chat UI: streamed transcript, conversation history, command palette, settings, per-tool permission prompts. Security-hardened.
- **TUI (`actoviq-tui`)** — Terminal UI with 25+ slash commands, Claude Code-style UX: `/team`, `/bridge`, `/plan`, `/hooks`, `/mcp`, `/review`, `/context`, `/cost`, `/doctor`, and more. Live status spinner, scrollback transcript, todo panel, permission dialogs with project/user scope, sub-command autocomplete.
- **Plan mode + hooks** — `EnterPlanMode`/`ExitPlanMode` tools with plan file; user-configurable `PreToolUse`/`PostToolUse`/`SessionStart` hooks from `settings.json`.
- **Worktree Tools** — `EnterWorktree`/`ExitWorktree` with stack-based cwd, `.worktreeinclude`, PR checkout.
- **TavilySearch** — AI-optimized web search, pure TypeScript.
- **Standard Benchmark** — Self-contained framework with DeepSeek judge, HTML dashboard, 4-agent comparison.

## Roadmap — toward agent teams

- **Swarm coordination** — mailbox-based inter-agent communication, task queues, shared knowledge graph.
- **Persistent team memory** — team-scoped context that survives across sessions and member changes.
- **Cross-runtime session continuity** — resume a bridge runtime's session exactly where you left it, regardless of which config was active.
- **Model team IDE** — visual team builder, member role editor, team health dashboard.

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

`actoviq-tui` is the full terminal UI, modeled on Claude Code's REPL design: the transcript prints into native scrollback while a redrawable bottom region hosts the status line, a Claude-style prompt bar, the slash-command menu, and permission dialogs.

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
- **Live status line** — spinner, elapsed time, tool count, and the active tool while the agent works, over an always-visible mode line (model · permission · effort · team · bridge · context%) that shows context usage as a percentage of the window and turns yellow then red as it fills.
- **Claude-style prompt bar** — type `\` then `Enter` (or `Ctrl+J`) for a newline; `↑`/`↓` walk input history; the caret renders inline.
- **Slash-command menu** — type `/` to open a filtered menu (`↑↓` select, `Tab` complete, `Enter` run). `/resume` opens a searchable project-session picker.
- **`@` file completion** — type `@` to open a git-aware workspace file picker filtered by the partial path; subsequence fuzzy matching.
- **Team / workflow / worktree pickers** — `/team` activates a saved Model Team; `/workflows` runs a saved dynamic workflow; `/worktree` enters, exits, or lists git worktrees.
- **Permission presets + per-tool scope** — `/permissions` switches between read-only/workspace/full/plan presets; always-allow rules persist with project or user scope.
- **Mid-run steering** — keep typing while the agent works and press `Enter`: the message is queued and injected into the very next model request (shown as `⧗ queued`).
- **Plan mode + hooks** — `/plan` enters plan mode (`EnterPlanMode`/`ExitPlanMode` tools, plan file); `PreToolUse`/`PostToolUse`/`SessionStart` hooks from settings.json; `/hooks` lists them.
- **Bridge configs** — `/bridge config` manages named connection profiles (name + runtime + apiKey + baseURL + model); `/bridge` lists them; selecting one switches the active runtime in-process. Per-config usage in `/cost` and `/usage`.
- **Diagnostics + inspection** — `/doctor` checks config health; `/context` inspects the context window; `/cost`/`/usage` track token + spend (per-config breakdown); `/review` reviews the git diff; `/stats` shows session stats.
- **Context management built in** — the Hadamard SDK auto-compacts long sessions mid-run and reactively recovers when a provider rejects an oversized prompt; compactions surface as `∿ context compacted` notices.
- **MCP management** — `/mcp add`/`/mcp remove` manage stdio + remote HTTP MCP servers, persisted to `~/.actoviq/mcp.json`.
- **Image attachments** — `@<path>.png` tokens expand into image content blocks (in-process, read as base64).

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
- **Project Documents + Issues** — each Project detail page has `Document` and `Issues` tabs. Issues use the guarded `backlog → todo → in_progress → in_review/blocked → done` lifecycle, support priorities, labels, acceptance criteria, comments, and links back to their worker sessions.
- **Agent Profiles for issue dispatch** — Settings → Models & routing can bind a named profile to a saved bridge config and model. `/issues start <id> [agent-profile]` asks the Project Manager for a worker brief, starts a linked session without changing the globally active runtime, and requires the worker to report through `IssueReport`.
- **Movable data root** — Settings → General can copy the complete Actoviq data root to an empty directory, validate it, write the bootstrap pointer, rebuild the SDK/session store, and retain the previous directory for manual cleanup.

**Security model:** the internal API is reachable only from loopback (Host + Origin allowlist, which defeats DNS-rebinding / CSRF) and requires a per-process token; the page ships a strict Content-Security-Policy. Electron runs with `sandbox`, `contextIsolation`, and no `nodeIntegration`.

Actoviq resolves its data root in this order: an explicit SDK `homeDir`, `ACTOVIQ_HOME`, `~/.actoviq/data-root.json`, then `~/.actoviq`. Project issues default to `<data-root>/projects/<workspace-key>/issues.json`; a project can instead use the protected workspace file `.actoviq/issues.json`.

> `electron` and `bun` are **optional** dependencies — installed only if you use the GUI / bridge runtime. The core SDK does not require them.
>
> **Bridge env overrides:** `ACTOVIQ_CLAUDE_PATH`, `ACTOVIQ_PI_PATH`, … (one per provider) to point the bridge at a specific runtime binary when it's not on `PATH`. See `docs/en/05-bridge-runtime.md`.

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
