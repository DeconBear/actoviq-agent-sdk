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
- Structured runtime metadata APIs for tools, skills, slash commands, and agents
- Memory and compact-state helpers aligned to the upstream session-memory and compact boundary flow
- Clean SDK agent definitions, agent-level hooks, Task-style delegation, background subagent tasks, and session/post-sampling/post-run hooks
- Permission rules, classifier approvals, api-microcompact context management, and reactive compact recovery in the clean SDK path
- Swarm/team orchestration with teammate sessions, side-session continuity, background task polling, and leader mailboxes
- Leader-to-teammate mailbox messages now flow into the teammate's next turn, improving side-session continuity without the bridge runtime
- Public computer-use replacement helpers that avoid private runtime dependencies
- Reactive compact recovery for oversized prompts, plus persisted compact/session-memory state
- Buddy APIs for hatching, muting, petting, and companion prompt-context generation
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

### 5. Inspect memory and compact state helpers

```bash
npm run example:actoviq-memory
npm run example:actoviq-session-memory
```

### npm Publishing

This repository is configured for npm trusted publishing from GitHub Actions.
Configure the trusted publisher on npmjs.com for `DeconBear/actoviq-agent-sdk`
with the workflow file `publish-npm.yml`. You do not need an `NPM_TOKEN`
secret for publishing once trusted publishing is set up correctly.

Trigger publishing from a version tag or GitHub Release publish event. Avoid
manual `workflow_dispatch` runs for trusted publishing, because npm documents
that manual dispatch workflows can cause trusted publisher validation
mismatches.

## At a Glance

This repository gives you two main paths:

1. A clean SDK layer for app integration
2. A runtime bridge layer for Actoviq-native non-TUI agent behavior

What you can use today:

- local tools with Zod schemas
- MCP servers over local, stdio, or streamable HTTP
- persistent sessions
- workspace helpers for standard directories, temp workspaces, and git worktrees
- bridge runtime introspection
- bridge capability metadata and event analysis helpers
- memory settings, session-memory prompts, and compact-state inspection helpers
- clean SDK named agents, agent-level hooks, Task delegation, background task polling, and reactive compact recovery
- clean SDK permission/classifier gates, api microcompact request shaping, swarm teammates, and public computer-use helpers
- clean SDK compact history persists locally, so `compactState()` can reconstruct compact/microcompact boundaries without bridge transcripts
- buddy helpers for companion state, reactions, and prompt-context injection
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

### Buddy Example

```ts
import { createActoviqBuddyApi } from 'actoviq-agent-sdk';

const buddy = createActoviqBuddyApi({
  configPath: './buddy-settings.json',
  userId: 'demo-user',
});

const companion = await buddy.hatch({
  name: 'Orbit',
  personality: 'curious, calm, and observant',
});

console.log(companion);
console.log(await buddy.pet());
console.log(await buddy.getPromptContext());
```

Run the repository example with:

```bash
npm run example:actoviq-buddy
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

### Session Memory Example

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const session = await sdk.createSession({ title: 'Session Memory Demo' });
await session.send('We should bump package.json before tagging the next release.');
await session.send('We also want CI green and concise release notes before publish.');

const extraction = await session.extractMemory();
const compactState = await session.compactState({
  includeSessionMemory: true,
  includeSummaryMessage: true,
});

console.log(extraction);
console.log(compactState.runtimeState);
console.log(compactState.sessionMemory?.content);
```

### Swarm / Teammate Example

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: 'Review release work and report the sharpest findings.',
    },
  ],
});

const team = sdk.swarm.createTeam({
  name: 'release-team',
  leader: 'lead',
  continuous: true,
});
await team.spawn({
  name: 'reviewer-1',
  agent: 'reviewer',
  prompt: 'Review the release checklist and report the top two risks.',
});

await team.message(
  'reviewer-1',
  'Leader note: focus on release blockers and anything that could break publish.',
);
await team.teammate('reviewer-1').continueFromMailbox();

const task = await team.runBackground('reviewer-1', 'Suggest one CI automation follow-up.');
await team.waitForIdle();

console.log(task.id);
console.log(await team.inbox());
```

Run the repository example with:

```bash
npm run example:actoviq-swarm
```

Swarm teammates now keep richer clean-SDK continuity metadata such as run lineage, mailbox-driven turns, recovery count, and the last completed task status. Use `team.continueFromMailbox(...)`, `team.continueAllFromMailbox()`, and `team.teammate(name).recover()` when you want a closer in-process teammate loop without switching to the bridge runtime.

### Permissions and Computer Use

```ts
import {
  createActoviqComputerUseToolkit,
  createAgentSdk,
} from 'actoviq-agent-sdk';

const toolkit = createActoviqComputerUseToolkit({
  executor: {
    openUrl: async (url) => console.log('open', url),
    focusWindow: async (title) => console.log('focus', title),
    typeText: async (text) => console.log('type', text),
    keyPress: async (keys) => console.log('keys', keys.join('+')),
    readClipboard: async () => 'clipboard text',
    writeClipboard: async (text) => console.log('clipboard', text),
    takeScreenshot: async (outputPath) => outputPath,
  },
});

const sdk = await createAgentSdk({
  permissionMode: 'plan',
  permissions: [{ toolName: 'computer_*', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName.startsWith('computer_')
      ? { behavior: 'allow', reason: 'Computer-use workflow approved for this run.' }
      : undefined,
  tools: toolkit.tools,
  mcpServers: [toolkit.mcpServer],
});
```

Safe repository demo:

```bash
npm run example:actoviq-computer-use
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

## Agent and Skill Helpers

The bridge SDK now also exposes higher-level helpers so you do not have to keep threading `agent` and slash-command details manually.

```ts
import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createActoviqBridgeSdk({ workDir: process.cwd() });

const reviewer = sdk.useAgent('general-purpose');
const reviewResult = await reviewer.run('Explain what this repository is for.');

const debugSkill = sdk.useSkill('debug');
const debugResult = await debugSkill.run(
  'briefly explain what kinds of debugging help this runtime can provide without printing secrets, tokens, or full config values',
);

const compactResult = await sdk.context.compact('summarize current progress');
const runtimeCatalog = await sdk.getRuntimeCatalog();
```

These helpers are also available as:

- `sdk.agents.list()`
- `sdk.agents.run(...)`
- `sdk.skills.list()`
- `sdk.skills.listMetadata()`
- `sdk.skills.run(...)`
- `sdk.tools.list()`
- `sdk.tools.listMetadata()`
- `sdk.slashCommands.list()`
- `sdk.slashCommands.listMetadata()`
- `sdk.getRuntimeCatalog()`
- `sdk.runWithAgent(...)`
- `sdk.runSkill(...)`
- `sdk.sessions.continueMostRecent(...)`
- `sdk.sessions.fork(...)`
- `session.runSkill(...)`
- `session.compact(...)`
- `session.info()`
- `session.messages()`
- `session.fork(...)`

The metadata APIs return structured entries that combine runtime discovery with
available `/context` usage information when present.

## Memory and Compact State

The SDK now exposes reusable helpers aligned to the upstream `claude-code`
session-memory and compact flow. This gives us a stable way to inspect
`.actoviq` memory paths, session-memory templates/prompts, compact boundaries,
the state needed to decide whether session-memory compaction is ready, and
the scan/select/surface pipeline for relevant memory files.

On the standard SDK path, relevant memories are now also auto-injected as
meta user reminders at the start of a turn when auto memory is enabled. The
SDK keeps a per-session surfaced-memory budget and de-duplicates already
surfaced files across turns.

Session-based SDK conversations now also align more closely with the upstream
`claude-code` session-memory loop:

- session memory is initialized automatically once the conversation is large enough
- extraction thresholds follow token growth, tool-call activity, and natural turn breaks
- the summary file is updated automatically after qualifying session turns
- you can still force a manual refresh with `session.extractMemory()`
- `session.compactState()` merges filesystem compact state with runtime extraction metadata

```ts
import {
  createActoviqMemoryApi,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const memory = createActoviqMemoryApi({
  projectPath: process.cwd(),
  sessionId: 'your-session-id',
});

const state = await memory.compactState({
  includeSessionMemory: true,
  includeBoundaries: true,
  includeSummaryMessage: true,
  currentTokenCount: 18000,
  tokensAtLastExtraction: 11000,
  initialized: true,
  toolCallsSinceLastUpdate: 4,
});

console.log(state.paths);
console.log(state.progress);
console.log(state.latestBoundary);
console.log(state.summaryMessage);
console.log(await memory.findRelevantMemories('how should I release this package?'));
console.log(await memory.surfaceRelevantMemories('how should I release this package?'));
```

Available helpers:

- `createActoviqMemoryApi(...)`
- `sdk.memory`
- `bridgeSdk.memory`
- `memory.paths()`
- `memory.getSettings()`
- `memory.updateSettings(...)`
- `memory.loadSessionTemplate()`
- `memory.loadSessionPrompt()`
- `memory.buildPromptWithEntrypoints()`
- `memory.buildSessionUpdatePrompt(...)`
- `memory.readSessionMemory(...)`
- `memory.scanMemoryFiles(...)`
- `memory.formatMemoryManifest(...)`
- `memory.findRelevantMemories(...)`
- `memory.surfaceRelevantMemories(...)`
- `memory.getSessionMemoryConfig()`
- `memory.getSessionMemoryCompactConfig()`
- `memory.evaluateSessionMemoryProgress(...)`
- `session.extractMemory(...)`
- `memory.compactState(...)`
- `memory.buildSessionMemoryCompactSummary(...)`
- `parseActoviqSessionMemoryRuntimeState(...)`
- `filterActoviqMessagesForSessionMemory(...)`
- `estimateActoviqConversationTokens(...)`
- `evaluateActoviqSessionMemoryProgress(...)`
- `getActoviqBridgeCompactBoundaries(...)`
- `getActoviqBridgeLatestCompactBoundary(...)`
- `session.compactState(...)`
- `sdk.context.compactState(...)`
- `sdk.sessions.getCompactState(...)`

Run the repository example with:

```bash
npm run example:actoviq-memory
npm run example:actoviq-session-memory
```

## Buddy Helpers

The SDK also exposes the non-TUI buddy/companion functionality as a reusable API.

```ts
import { createActoviqBuddyApi } from 'actoviq-agent-sdk';

const buddy = createActoviqBuddyApi({ configPath: './settings.json' });
const state = await buddy.state();

if (!state.buddy) {
  await buddy.hatch({
    name: 'Orbit',
    personality: 'curious, steady, and supportive',
  });
}

console.log(await buddy.getPromptContext());
```

Available helpers:

- `createActoviqBuddyApi(...)`
- `sdk.buddy`
- `bridgeSdk.buddy`
- `buddy.state()`
- `buddy.get()`
- `buddy.hatch(...)`
- `buddy.mute()`
- `buddy.unmute()`
- `buddy.pet()`
- `buddy.getPromptContext(...)`
- `buddy.getIntroAttachment(...)`
- `buddy.getIntroText(...)`

On the standard SDK path, buddy intro text is also appended to the system
prompt automatically when a buddy is hatched and not muted.

## Event Helpers

The bridge also exports reusable event helpers so examples and applications do
not need to hand-parse raw JSON events:

```ts
import {
  analyzeActoviqBridgeEvents,
  getActoviqBridgeTextDelta,
} from 'actoviq-agent-sdk';

const stream = sdk.stream('inspect the current repository');
const bufferedEvents = [];

for await (const event of stream) {
  bufferedEvents.push(event);

  const delta = getActoviqBridgeTextDelta(event);
  if (delta) {
    process.stdout.write(delta);
  }
}

const analysis = analyzeActoviqBridgeEvents(bufferedEvents);
console.log(analysis.toolRequests);
console.log(analysis.taskInvocations);
console.log(analysis.toolResults);
```

Available helpers:

- `getActoviqBridgeTextDelta(...)`
- `extractActoviqBridgeToolRequests(...)`
- `extractActoviqBridgeToolResults(...)`
- `extractActoviqBridgeTaskInvocations(...)`
- `analyzeActoviqBridgeEvents(...)`

## Workspace Helpers

The SDK now includes explicit workspace lifecycle helpers so you can create isolated directories before starting an agent session.

```ts
import {
  createAgentSdk,
  createTempWorkspace,
  createActoviqFileTools,
} from 'actoviq-agent-sdk';

const workspace = await createTempWorkspace({
  prefix: 'actoviq-demo-',
  copyFrom: './examples',
});

const sdk = await createAgentSdk({
  workDir: workspace.path,
  tools: createActoviqFileTools({ cwd: workspace.path }),
});

await sdk.close();
await workspace.dispose();
```

Available helpers:

- `createWorkspace(...)`
- `createTempWorkspace(...)`
- `createGitWorktreeWorkspace(...)`

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
- higher-level agent, skill, and context helpers are available on the bridge SDK
- structured runtime metadata and bridge event helper APIs are available
- buddy APIs are available on both the standard SDK and the bridge SDK
- file tools are available: `Read`, `Write`, `Edit`, `Glob`, and `Grep`
- workspace lifecycle helpers are available for directory, temp, and git-worktree setups
- examples, tests, build, smoke checks, and package validation are in place

Roadmap:

- deepen context, memory, and compaction controls
- extend metadata coverage beyond runtime discovery into richer skill/subagent details
- add richer workspace templates and sandbox orchestration helpers
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
npm run example:actoviq-buddy
npm run example:actoviq-bridge-sdk
npm run example:actoviq-interactive-agent
npm run example:actoviq-introspection
npm run example:actoviq-file-tools
npm run example:actoviq-agent-helpers
npm run example:actoviq-workspaces
npm run example:actoviq-sessions
npm run example:actoviq-session-messages
```

`npm run smoke` loads `~/.actoviq/settings.json` and validates a live request.

## Contributing

This is still a fast-moving preview project. If you hit problems, see missing parity, or want to propose a cleaner API, please open an issue or submit a PR.
