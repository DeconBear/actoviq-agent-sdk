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
- Tab completion for slash commands (`/help`, `/clear`, `/compact`, `/memory`, `/model`, `/tools`, `/dream`, `/exit`)
- Command history via ↑↓ arrow keys
- Ctrl+C to abort the current request, press twice to exit

**Note:** `actoviq-react` is a lightweight scrollback REPL, **not a full-featured TUI**. It does not use an alternate screen buffer, ScrollBox, or rich terminal rendering. It is designed for quick interaction and debugging, not as a replacement for a complete terminal UI.

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
