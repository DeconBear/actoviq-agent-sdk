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

## 一眼看懂这个仓库

这个仓库现在主要提供两条使用路径：

1. 用于业务集成的干净 SDK 层
2. 用于复用 Actoviq 原生非 TUI agent 行为的 runtime bridge 层

当前已经可用的能力包括：

- 基于 Zod 的本地工具定义
- 本地、stdio、streamable HTTP 三类 MCP 接入
- 持久化 session
- bridge runtime introspection
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

## Runtime Introspection

如果你想检查当前 bridge runtime 实际加载了哪些能力，而不是直接让 agent 执行任务，可以使用 introspection 示例。

启动命令：

```bash
npm run example:actoviq-introspection
```

它会输出：

- 当前运行模型
- 当前内置工具列表
- 当前已加载 skills
- 当前 slash commands
- 当前可用 agents
- 当前上下文使用情况

## 文件工具

你可以把第一阶段的 Actoviq Runtime parity 文件工具直接挂到 SDK 上：

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

当前文件工具包括：

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`

## 原生 Runtime Sessions

你也可以通过 vendored 的 portable session discovery 逻辑读取 Actoviq Runtime 原生 `.actoviq/projects` session 存储。

```ts
import { listActoviqBridgeSessions } from 'actoviq-agent-sdk';

const sessions = await listActoviqBridgeSessions({ limit: 10 });
console.log(sessions);
```

如果你想恢复某个 session 的最近主链对话：

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

## 配置说明

SDK 会按以下顺序解析配置：

1. `createAgentSdk()` 显式传入的参数
2. `process.env`
3. 通过 `loadJsonConfigFile(...)` 预加载的 JSON 文件

示例：

```ts
import { loadJsonConfigFile } from 'actoviq-agent-sdk';

await loadJsonConfigFile('E:/configs/my-llm-config.json');
```

JSON 文件可以写成这两种结构：

```json
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "token",
    "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
    "ACTOVIQ_DEFAULT_SONNET_MODEL": "my-model"
  }
}
```

或者：

```json
{
  "ACTOVIQ_AUTH_TOKEN": "token",
  "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
  "ACTOVIQ_DEFAULT_SONNET_MODEL": "my-model"
}
```

支持的键包括：

- `ACTOVIQ_API_KEY`
- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_MODEL`
- `ACTOVIQ_DEFAULT_SONNET_MODEL`
- `ACTOVIQ_DEFAULT_OPUS_MODEL`
- `ACTOVIQ_DEFAULT_HAIKU_MODEL`

为了兼容现有上游 settings 文件，JSON loader 也接受以下上游兼容键名：

- `ACTOVIQ_AUTH_TOKEN`
- `ACTOVIQ_BASE_URL`
- `ACTOVIQ_DEFAULT_SONNET_MODEL`
- `ACTOVIQ_DEFAULT_OPUS_MODEL`
- `ACTOVIQ_DEFAULT_HAIKU_MODEL`

本地示例和 smoke 测试也可以直接使用：

```ts
import { loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
```

这个 helper 读取：

1. `~/.actoviq/settings.json`

## MCP Helper

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

## 当前状态与路线图

当前状态：

- npm 包已经发布，可直接安装使用
- 核心 SDK 主链已可用：`run()`、`stream()`、session、tools、MCP
- bridge runtime 主链已可用：内置工具、runtime introspection、交互式示例
- 文件工具已经可用：`Read`、`Write`、`Edit`、`Glob`、`Grep`
- examples、tests、build、smoke 和打包校验都已经具备

路线图：

- 补更直接的 subagent 高层 API，而不仅仅是 bridge 复用
- 完善 skill 管理和程序化 skill 调用接口
- 补 workspace 生命周期能力，例如临时工作区和 git worktree 支持
- 继续补 context、memory、compact 等更深层控制能力
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
npm run example:actoviq-sessions
npm run example:actoviq-session-messages
```

`npm run smoke` 会读取 `~/.actoviq/settings.json` 并执行一次真实联调验证。

## 参与贡献

当前项目仍在快速迭代中。如果你发现问题、看到缺失的 parity 能力，或者想提出更好的 API 设计，欢迎直接提 Issue 或发 PR。
