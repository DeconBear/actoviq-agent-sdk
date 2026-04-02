# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)

[English](./README.md) | [中文](./README-zh.md)

Actoviq Agent SDK 是一个独立的实验性 agent SDK 项目，聚焦多工具、多会话以及 bridge 辅助的 agent 工作流。

当前仓库仍处于测试预览版阶段，并且还在持续开发中。API、运行时行为、命名、打包方式以及 parity 覆盖范围后续都可能继续调整。欢迎大家提交 Issue 和 PR。

本项目当前以公开预览形式持续迭代开发，接口和运行时能力仍会继续完善。

本项目采用 [MIT License](./LICENSE) 开源协议。

## 项目亮点

- 提供 Node.js / TypeScript agent SDK，包含 `run()`、`stream()`、session、tools 和 MCP 支持
- 提供 Actoviq Runtime bridge，可复用 built-in tools、skills、subagents 和原生 session/context 行为
- 提供与上游 session-memory / compact 边界语义对齐的 memory 与 compact state helper
- 提供 buddy / companion API，可用于孵化、静音、抚摸，以及生成 companion prompt context
- 在 vendored 非 TUI runtime 之上提供更干净的对外 SDK 表面
- 提供交互式流式示例，便于本地调试 agent
- 持续补齐 workspace 管理、更深层 subagent API，以及私有依赖替代

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备 `~/.actoviq/settings.json`

本地示例默认读取这个文件：

```text
~/.actoviq/settings.json
```

如果目录还不存在，可以先创建：

```powershell
New-Item -ItemType Directory -Force $HOME\.actoviq | Out-Null
```

### 3. 运行基础示例

```bash
npm run example:quickstart
```

### 4. 启动交互式 agent 示例

```bash
npm run example:actoviq-interactive-agent
```

它会启动一个带流式输出、工具调用能力和无限循环会话的交互式 REPL，直到你主动退出。

### 5. 查看 memory / compact state 示例

```bash
npm run example:actoviq-memory
```

## 一眼看懂这个仓库

这个仓库现在主要提供两条使用路径：

1. 用于业务集成的干净 SDK 层
2. 用于复用 Actoviq 原生非 TUI agent 行为的 runtime bridge 层

当前已经可用的能力包括：

- 基于 Zod 的本地工具定义
- 本地、stdio、streamable HTTP 三类 MCP 接入
- 持久化 session
- bridge runtime introspection
- memory 设置、session-memory prompt、compact state 检查 helper
- vendored runtime 文件工具：`Read`、`Write`、`Edit`、`Glob`、`Grep`
- bridge runtime 的 built-in tools、skills 和 subagents

## 作为库安装

```bash
npm install actoviq-agent-sdk zod
```

## 基础 SDK 示例

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

## 核心示例

### 多轮会话示例

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Demo Session' });

await session.send('Remember that my project codename is Sparrow.');
const reply = await session.send('What is my project codename?');

console.log(reply.text);
```

### 循环流式示例

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

### Buddy 示例

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

仓库内可直接运行：

```bash
npm run example:actoviq-buddy
```

## 交互式 Agent 示例

仓库中包含一个基于 bridge 的交互式示例，具备：

- 流式回答
- 内置工具访问能力
- vendored runtime 提供的 skills 和 subagents
- 可在代码中直接设置工作空间路径
- 可在代码中直接设置 JSON 配置路径
- 无限循环，直到用户主动退出

启动命令：

```bash
npm run example:actoviq-interactive-agent
```

主要可调项位于：
[`examples/actoviq-interactive-agent.ts`](./examples/actoviq-interactive-agent.ts)

```ts
const WORKSPACE_PATH = process.cwd();
const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'interactive-agent.settings.local.json',
);
```

仓库中包含：

- [`examples/interactive-agent.settings.example.json`](./examples/interactive-agent.settings.example.json)：安全模板
- `examples/interactive-agent.settings.local.json`：仅供本机调试使用的本地配置文件

其中本地调试文件已被 git 忽略。

## Runtime Bridge

你也可以直接通过本 SDK 调起 vendored 的非 TUI Actoviq Runtime。
这层 bridge 复用了上游 headless CLI，因此会带上内置工具池、skills、subagents，以及原生 session/context 行为。

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

Bridge 说明：

- 它通过 Bun 执行 vendored 的 Actoviq Runtime CLI bundle
- 会自动注入由 `loadJsonConfigFile(...)` 或 `loadDefaultActoviqSettings()` 加载的环境变量
- 如果系统里可用 `rg`，bridge 会优先使用系统 `rg`，保证 `Glob` 和 `Grep` 在缺少 bundled ripgrep 二进制时依旧可工作

## Agent / Skill Helper

bridge SDK 现在补上了更直接的高层 helper，不需要你每次手动拼 `agent` 参数或 slash command。

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

当前可以直接使用：

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

## Memory / Compact Helper

SDK 现在也提供了可复用的 memory / compact state helper，设计上对齐上游
`claude-code` 的 session-memory 与 compact boundary 语义。这样我们可以直接检查
`.actoviq` 下的 memory 路径、session-memory 模板与 prompt、compact 边界历史，
以及当前是否满足 session-memory 提取或 compaction 的阈值条件，同时也补上
relevant memory 的 scan / select / surface helper。

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

当前可直接使用：

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
- `memory.compactState(...)`
- `memory.buildSessionMemoryCompactSummary(...)`
- `getActoviqBridgeCompactBoundaries(...)`
- `getActoviqBridgeLatestCompactBoundary(...)`
- `session.compactState(...)`
- `sdk.context.compactState(...)`
- `sdk.sessions.getCompactState(...)`

仓库内示例命令：

```bash
npm run example:actoviq-memory
```

## Buddy Helper

SDK 现在也把非 TUI 的 buddy / companion 能力封装成了可复用 API。

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

当前可直接使用：

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

在标准 SDK 路径下，如果 buddy 已孵化且未静音，companion intro text 也会自动附加到 system prompt 中。

## Event Helper

bridge 现在也提供了可复用的事件解析 helper，方便统一处理 `Task` / subagent / tool 相关事件。

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

- `getActoviqBridgeTextDelta(...)`
- `extractActoviqBridgeToolRequests(...)`
- `extractActoviqBridgeToolResults(...)`
- `extractActoviqBridgeTaskInvocations(...)`
- `analyzeActoviqBridgeEvents(...)`

## Workspace Helper

现在 SDK 也补上了显式的 workspace 生命周期 helper，便于先创建隔离目录，再启动 agent 会话。

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

当前提供：

- `createWorkspace(...)`
- `createTempWorkspace(...)`
- `createGitWorktreeWorkspace(...)`


## 当前状态与路线图

当前状态：

- npm 包已经发布，可直接安装使用
- 核心 SDK 主链已可用：`run()`、`stream()`、session、tools、MCP
- bridge runtime 主链已可用：内置工具、runtime introspection、交互式示例
- bridge SDK 已补更高层的 agent / skill / context helper
- bridge SDK 已补结构化 metadata API 和 event helper
- buddy API 已在标准 SDK 和 bridge SDK 两侧可用
- 文件工具已经可用：`Read`、`Write`、`Edit`、`Glob`、`Grep`
- workspace 生命周期 helper 已可用：目录、临时工作区、git worktree
- examples、tests、build、smoke 和打包校验都已经具备

路线图：

- 继续补 context、memory、compact 等更深层控制能力
- 继续补更丰富的 agent / skill / subagent metadata 细节
- 继续补更完整的 workspace 模板和 sandbox orchestration
- 补 CI、release notes，以及更完整的贡献文档

## 本地开发命令

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
npm run example:actoviq-agent-helpers
npm run example:actoviq-workspaces
npm run example:actoviq-sessions
npm run example:actoviq-session-messages
npm run example:actoviq-buddy
```

`npm run smoke` 会读取 `~/.actoviq/settings.json` 并执行一次真实联调验证。

## 参与贡献

当前项目仍在快速迭代中。如果你发现问题、看到缺失的 parity 能力，或者想提出更好的 API 设计，欢迎直接提 Issue 或发 PR。
