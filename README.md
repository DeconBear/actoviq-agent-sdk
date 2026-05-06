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

const sdk = await createAgentSdk();

try {
  const result = await sdk.run('Introduce yourself in one short sentence.');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

Run the repository examples with:

```bash
npm run example:quickstart
npm run example:actoviq-agent-helpers
```

## Tutorials

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- Chinese tutorial: [docs/zh/README.md](./docs/zh/README.md)
- GitHub Pages docs site:
  - https://deconbear.github.io/actoviq-agent-sdk/

If you want the clean SDK path first, start with:

- [examples/quickstart.ts](./examples/quickstart.ts)
- [examples/actoviq-skills.ts](./examples/actoviq-skills.ts)
- [examples/actoviq-agent-helpers.ts](./examples/actoviq-agent-helpers.ts)

## Contributing

Contributions are welcome. If you spot a bug or a documentation gap, please open an issue or submit a pull request.

Licensed under the [MIT License](./LICENSE).
