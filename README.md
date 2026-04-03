# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)

[English](./README.md) | [中文](./README-zh.md)

Actoviq Agent SDK is an experimental TypeScript SDK for building multi-tool, multi-session agents with clean SDK APIs, MCP integration, memory helpers, and an optional runtime bridge path.

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
npm run example:actoviq-interactive-agent
```

## Tutorials

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- 中文教程: [docs/zh/README.md](./docs/zh/README.md)

If you want a ready-to-run terminal chat program with streaming output and tool calls, start with:

- [examples/actoviq-interactive-agent.ts](./examples/actoviq-interactive-agent.ts)

If you want the clean SDK path first, start with:

- [examples/quickstart.ts](./examples/quickstart.ts)
- [examples/actoviq-skills.ts](./examples/actoviq-skills.ts)

## Contributing

Contributions are welcome. If you spot a bug, a documentation gap, or a parity issue, please open an issue or submit a pull request.

Licensed under the [MIT License](./LICENSE).
