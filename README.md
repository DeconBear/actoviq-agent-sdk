# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [Chinese](./README-zh.md)

Documentation site: https://deconbear.github.io/actoviq-agent-sdk/

Actoviq Agent SDK is an experimental TypeScript SDK for building multi-tool, multi-session agents with a clean-first public API, MCP integration, and memory helpers.

This project is inspired by excellent agent projects and runtimes including Claude Code, Codex, Deepagents, and similar work in the ecosystem. Actoviq remains an independent project with its own public SDK surface and documentation.

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

`actoviq-tui` is the full terminal UI for the Clean SDK, modeled on Claude Code's REPL design: the transcript prints into native scrollback while a redrawable bottom region hosts the status line, a Claude-style prompt bar, the slash-command menu, and permission dialogs.

```bash
npx actoviq-tui [work-dir] [options]

# Options
#   --config <path>            Load a specific Actoviq settings JSON file
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)
#   --model <model>            Override the configured model
#   --resume <session-id>      Resume a stored Clean SDK session
#   --continue                 Continue the most recently updated session
```

Features:

- **Streaming transcript in native scrollback** — assistant text, `⏺ Tool(args)` calls, and `⎿ ✓/✗` result lines flush into the normal terminal buffer; scrollback and copy/paste work as usual.
- **Live status line** — spinner, elapsed time, tool count, context-size estimate, and the current tool while the agent works.
- **Claude-style prompt bar** — type `\` then `Enter` (or `Ctrl+J`) for a newline; `↑`/`↓` walk input history; the caret renders inline.
- **Slash-command menu** — type `/` to open a filtered menu (`↑↓` select, `Tab` complete, `Enter` run). Runtime controls include `/compact [instructions]`, `/model [model|min|medium|max|default]`, `/permissions [mode]`, `/sessions`, and `/resume <session-id>`.
- **Mid-run steering** — keep typing while the agent works and press `Enter`: the message is queued and injected into the very next model request (shown as `⧗ queued`).
- **Permission dialogs** — with `--permission-mode default`, mutating tools pause for an approve / always-allow / deny dialog. Always-allow choices are stored with the session and restored on resume.
- **Interrupts** — `Esc` aborts the current run; `Ctrl+C` clears the input (twice quickly exits); `Ctrl+D` exits on an empty prompt.
- **Context management built in** — the Clean SDK auto-compacts long sessions mid-run and reactively recovers when a provider rejects an oversized prompt; compactions surface as `∿ context compacted` notices.

Both CLIs share the same Clean SDK runtime defaults (Actoviq settings from `~/.actoviq/settings.json`, core tools, `bypassPermissions`, uncapped tool iterations) and run against any Anthropic-compatible or OpenAI-compatible provider.

Model tiers are provider-neutral aliases. Configure them with `ACTOVIQ_DEFAULT_MIN_MODEL`, `ACTOVIQ_DEFAULT_MEDIUM_MODEL`, and `ACTOVIQ_DEFAULT_MAX_MODEL`, then use `min`, `medium`, or `max` anywhere a model can be selected.

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
