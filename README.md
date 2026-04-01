# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)

[English](./README.md) | [中文](./README-zh.md)

Actoviq Agent SDK is an independent, experimental agent SDK for practical multi-tool, multi-session, and bridge-assisted agent workflows.

This repository is currently a testing preview under active development. APIs, runtime behavior, naming, packaging, and parity coverage may still change as the project evolves. Issues and PRs are very welcome.

This project is independently developed as a public preview and is still under active iteration.

Licensed under the [MIT License](./LICENSE).

## Highlights

- Node.js / TypeScript agent SDK with `run()`, `stream()`, sessions, tools, and MCP support
- Actoviq Runtime bridge with built-in tools, skills, subagents, and native session/context behavior
- Clean public SDK surface on top of a vendored non-TUI runtime
- Interactive streaming demo for local development and agent debugging
- Ongoing parity work for workspace management, deeper subagent APIs, and private dependency replacement

## Get Started

### 1. Install dependencies

```bash
npm install
```

### 2. Prepare `~/.actoviq/settings.json`

Local examples expect this file:

```text
~/.actoviq/settings.json
```

Create the directory and place your JSON settings file there if it does not exist yet:

```powershell
New-Item -ItemType Directory -Force $HOME\.actoviq | Out-Null
```

### 3. Run the basic example

```bash
npm run example:quickstart
```

### 4. Start the interactive agent demo

```bash
npm run example:actoviq-interactive-agent
```

This launches a streaming REPL with tool access and an infinite session loop until you exit.

## At a Glance

This repository gives you two main paths:

1. A clean SDK layer for app integration
2. A runtime bridge layer for Actoviq-native non-TUI agent behavior

What you can use today:

- local tools with Zod schemas
- MCP servers over local, stdio, or streamable HTTP
- persistent sessions
- bridge runtime introspection
- vendored runtime file tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`
- built-in bridge runtime tools, skills, and subagents

## Install As a Library

```bash
npm install actoviq-agent-sdk zod
```

## Basic SDK Example

```ts
import { z } from 'zod';
import { createAgentSdk, loadDefaultActoviqSettings, tool } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers together.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);

const result = await sdk.run('Please use the add_numbers tool to calculate 19 + 23.', {
  tools: [addNumbers],
  systemPrompt: 'Use the provided tools whenever they are relevant.',
});

console.log(result.text);
await sdk.close();
```

## Core Examples

### Session Example

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Demo Session' });

await session.send('Remember that my project codename is Sparrow.');
const reply = await session.send('What is my project codename?');

console.log(reply.text);
```

### Stream Loop Example

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const prompts = [
  'Introduce yourself in one concise sentence.',
  'Now summarize the key idea of your previous sentence in one sentence.',
  'Finally, give two short suggestions that would help a developer call this SDK more reliably.',
];

const session = await sdk.createSession({ title: 'Stream Loop Example' });

for (const prompt of prompts) {
  const stream = session.stream(prompt);

  for await (const event of stream) {
    if (event.type === 'response.text.delta') {
      process.stdout.write(event.delta);
    }
  }

  const result = await stream.result;
  console.log('\nfinal:', result.text);
}

await sdk.close();
```

## Interactive Agent Demo

The repository includes a bridge-based interactive example with:

- streaming answers
- built-in tool access
- skills and subagents through the vendored runtime
- a configurable workspace path in code
- an explicit JSON config path in code
- an infinite REPL loop until the user exits

Run it with:

```bash
npm run example:actoviq-interactive-agent
```

The main knobs are defined at the top of
[`examples/actoviq-interactive-agent.ts`](./examples/actoviq-interactive-agent.ts):

```ts
const WORKSPACE_PATH = process.cwd();
const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'interactive-agent.settings.local.json',
);
```

The repository includes:

- [`examples/interactive-agent.settings.example.json`](./examples/interactive-agent.settings.example.json): safe template
- `examples/interactive-agent.settings.local.json`: local debug file for your machine only

The local debug file is ignored by git.

## Runtime Bridge

You can also run the vendored non-TUI Actoviq Runtime directly from this SDK.
This bridge reuses the upstream headless CLI, so it brings along the built-in
tool pool, skills, subagents, and native session/context behavior.

```ts
import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

const result = await sdk.run(
  'Use Actoviq Runtime tools to inspect the examples directory, then summarize examples/quickstart.ts.',
);

console.log(result.initEvent?.agents);
console.log(result.initEvent?.skills);
console.log(result.sessionId);
console.log(result.text);
console.log(result.events.length);
```

Bridge notes:

- It uses Bun to execute the vendored Actoviq Runtime CLI bundle.
- It automatically injects env values loaded by `loadJsonConfigFile(...)` or `loadDefaultActoviqSettings()`.
- When a system `rg` is available, the bridge prefers it automatically so `Glob` and `Grep` work even if the upstream checkout does not contain the bundled ripgrep binary.

## Runtime Introspection

Use the runtime introspection example when you want to inspect the currently loaded bridge runtime instead of chatting with it.

Run it with:

```bash
npm run example:actoviq-introspection
```

It prints:

- runtime model
- built-in tools
- loaded skills
- slash commands
- available agents
- current context usage

## File Tools

You can attach the first-stage Actoviq Runtime parity file tools directly to the SDK:

```ts
import {
  createAgentSdk,
  createActoviqFileTools,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  tools: createActoviqFileTools({
    cwd: process.cwd(),
  }),
});

const result = await sdk.run(
  'Use Glob to inspect the examples directory, then use Read on examples/quickstart.ts.',
);

console.log(result.text);
console.log(result.toolCalls);
```

Current parity file tools:

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`

## Native Runtime Sessions

You can inspect Actoviq Runtime's native `.actoviq/projects` session store using the vendored portable session discovery logic.

```ts
import { listActoviqBridgeSessions } from 'actoviq-agent-sdk';

const sessions = await listActoviqBridgeSessions({ limit: 10 });
console.log(sessions);
```

To inspect the latest reconstructed conversation chain for a session:

```ts
import {
  getActoviqBridgeSessionInfo,
  getActoviqBridgeSessionMessages,
} from 'actoviq-agent-sdk';

const sessionId = 'your-session-id';

const info = await getActoviqBridgeSessionInfo(sessionId);
const messages = await getActoviqBridgeSessionMessages(sessionId);

console.log(info);
console.log(messages);
```

## Configuration

The SDK resolves credentials in this order:

1. Explicit options passed to `createAgentSdk()`
2. Process environment variables
3. A JSON file preloaded with `loadJsonConfigFile(...)`

Example:

```ts
import { loadJsonConfigFile } from 'actoviq-agent-sdk';

await loadJsonConfigFile('E:/configs/my-llm-config.json');
```

The JSON file can use either of these shapes:

```json
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "token",
    "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
    "ACTOVIQ_DEFAULT_SONNET_MODEL": "my-model"
  }
}
```

or:

```json
{
  "ACTOVIQ_AUTH_TOKEN": "token",
  "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
  "ACTOVIQ_DEFAULT_SONNET_MODEL": "my-model"
}
```

Supported values include:

- `ACTOVIQ_API_KEY`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_MODEL`
- `ACTOVIQ_DEFAULT_SONNET_MODEL`
- `ACTOVIQ_DEFAULT_OPUS_MODEL`
- `ACTOVIQ_DEFAULT_HAIKU_MODEL`

For local examples and smoke tests, you can also use:

```ts
import { loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
```

This helper reads:

1. `~/.actoviq/settings.json`

## MCP Helpers

```ts
import { createAgentSdk, loadDefaultActoviqSettings, stdioMcpServer } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  mcpServers: [
    stdioMcpServer({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    }),
  ],
});
```

## Status and Roadmap

Current status:

- npm package is published and installable
- core SDK flows are working: `run()`, `stream()`, sessions, tools, and MCP
- bridge runtime flows are working: built-in tools, runtime introspection, and interactive demo
- file tools are available: `Read`, `Write`, `Edit`, `Glob`, and `Grep`
- examples, tests, build, smoke checks, and package validation are in place

Roadmap:

- add higher-level subagent APIs instead of only bridge-level reuse
- improve skill management and programmatic skill invocation APIs
- add workspace lifecycle helpers such as temp workspaces and git worktree support
- deepen context, memory, and compaction controls
- add CI workflows, release notes, and more polished contributor docs

## Local Development

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run example:quickstart
npm run example:session
npm run example:stream-loop
npm run example:actoviq-bridge-sdk
npm run example:actoviq-interactive-agent
npm run example:actoviq-introspection
npm run example:actoviq-file-tools
npm run example:actoviq-sessions
npm run example:actoviq-session-messages
```

`npm run smoke` loads `~/.actoviq/settings.json` and validates a live request.

## Contributing

This is still a fast-moving preview project. If you hit problems, see missing parity, or want to propose a cleaner API, please open an issue or submit a PR.
