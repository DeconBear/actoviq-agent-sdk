# 01. 环境准备与快速启动

这一章的目标很简单：尽快把 SDK 跑起来。

## 0. 当前 SDK 有两条入口

- 想快速获得聊天、sessions、skills、memory、MCP、文件工具、GUI/TUI/CLI：使用 package root 的 `createAgentSdk()`。
- 想自行组合 provider、runtime、tool policy、storage 和 orchestration：使用职责 subpath。

职责 subpath 的对应关系：

| 导入路径 | 负责什么 |
|---|---|
| `actoviq-agent-sdk/core` | `AgentSpec`、canonical items、run/result/usage contract |
| `actoviq-agent-sdk/providers` | provider adapter、capability preflight、model registry、transport |
| `actoviq-agent-sdk/runtime` | `AgentRuntime`、tools、middleware、services、checkpoint/resume |
| `actoviq-agent-sdk/events` | 结构化 run events、processors、OpenTelemetry |
| `actoviq-agent-sdk/orchestration` | child agent、handoff、background、确定性 `WorkflowGraph` |
| `actoviq-agent-sdk/workflow` | trusted/untrusted workflow executor 与路由 |
| `actoviq-agent-sdk/profiles` | chat/coding/research/workflow/supervisor/background profiles |
| `actoviq-agent-sdk/node` | SQLite sessions/checkpoints/children 与存储 adapter |
| `actoviq-agent-sdk/compat` | 0.x compatibility façade |

两条路线可以共存，但不要把 actoviq-bridge-sdk 当成 Hadamard Runtime 的依赖。Bridge 只在需要接外部 Agent CLI 时使用。

## 1. 安装

先确认 Node.js 满足：

```text
^22.13.0 || ^24.0.0
```

如果你在自己的项目里使用：

```bash
npm install actoviq-agent-sdk zod
```

如果你在当前仓库里调试：

```bash
npm install
```

## 2. 准备 JSON 配置

本地最简单的方式是准备：

```text
~/.actoviq/settings.json
```

示例：

```json
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "your-token",
    "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
    "ACTOVIQ_DEFAULT_MIN_MODEL": "your-fast-model",
    "ACTOVIQ_DEFAULT_MEDIUM_MODEL": "your-balanced-model",
    "ACTOVIQ_DEFAULT_MAX_MODEL": "your-capable-model"
  }
}
```

如果你不想使用默认位置，也可以在代码里先调用 `loadJsonConfigFile(...)` 加载任意路径的 JSON。

### 选择协议提供方

`createAgentSdk()` 兼容入口支持 Anthropic 与 OpenAI-compatible 两类协议，通过 `provider` 选择（默认 `'anthropic'`）。

**Anthropic 协议**（默认）：

```ts
const sdk = await createAgentSdk({
  // provider: 'anthropic' 为默认值
  baseURL: 'https://api.anthropic.com',
  apiKey: 'sk-ant-xxx',
  model: 'medium',
});
```

**OpenAI 协议** — 兼容 OpenAI、DeepSeek、vLLM 及任何 OpenAI 兼容接口：

```ts
const sdk = await createAgentSdk({
  provider: 'openai',
  baseURL: 'https://api.openai.com',        // 或 https://api.deepseek.com
  apiKey: 'sk-xxx',
  model: 'gpt-4o',                          // 或 deepseek-chat
});
```

也可以通过环境变量或 JSON 配置文件设置：

```json
{
  "env": {
    "ACTOVIQ_PROVIDER": "openai",
    "ACTOVIQ_API_KEY": "sk-xxx",
    "ACTOVIQ_BASE_URL": "https://api.deepseek.com",
    "ACTOVIQ_MODEL": "deepseek-chat"
  }
}
```

兼容入口自动处理协议转换。无论选择哪种协议，`sdk.run()`、`session.send()`、`workflow`、`parallel()` 等高层 API 的使用方式一致。

模块化 `/providers` 进一步区分 `AnthropicModelProvider`、`OpenAIResponsesProvider` 与 `OpenAIChatCompatProvider`，并在请求前检查模型是否支持 tools、structured output、reasoning、streaming 等能力。

## 3. 第一个 SDK 调用

### 快速/兼容入口

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

try {
  const result = await sdk.run('请用一句话做自我介绍。');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

`createAgentSdk()` 会按 Actoviq settings 解析 provider、模型、sessions、skills、memory 和核心工具，适合直接做交互应用。

### 模块化 Runtime 入口

新 SDK 集成可以显式组合 provider 与 runtime：

```ts
import type { AgentSpec } from 'actoviq-agent-sdk/core';
import {
  ModelRegistry,
  OpenAIResponsesProvider,
} from 'actoviq-agent-sdk/providers';
import { AgentRuntime } from 'actoviq-agent-sdk/runtime';

const provider = new OpenAIResponsesProvider({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
});

const runtime = new AgentRuntime({
  models: new ModelRegistry([provider]),
  defaultModel: {
    provider: 'openai-responses',
    model: 'gpt-4.1-mini',
  },
});

const agent: AgentSpec = {
  id: 'quickstart',
  name: 'Quickstart',
  instructions: 'Answer clearly and briefly.',
};

try {
  const result = await runtime.run(agent, '请用一句话做自我介绍。');
  console.log(result.output);
} finally {
  await runtime.close();
}
```

这里不会隐式加载 sessions、tools 或 memory。需要什么能力，就通过 `AgentRuntime` 的 `tools`、`services`、`middleware` 等选项显式注入。

## 4. CLI 交互式 REPL（scrollback 模式）

安装包后，可以直接启动内置的交互式 REPL：

```bash
npx actoviq-react [工作目录]
```

这是一个基于 readline 的 Agent，在主终端缓冲区运行：
- 直接输入消息，实时流式输出回复
- 使用 `/` 斜杠命令：`/help`、`/clear`、`/compact`、`/memory`、`/model`、`/tools`、`/dream`、`/exit`
- Tab 补全命令，↑↓ 浏览历史
- Ctrl+C 一次中止当前请求，连按两次退出

**注意：** `actoviq-react` 是一个轻量级 scrollback REPL，**不是完整的 TUI**——没有 alternate screen buffer、没有 ScrollBox、没有富文本终端渲染。它适用于快速交互和调试。完整终端 UI 请使用 `actoviq-tui`。

## 5. 终端 UI（TUI）

包内还包含完整的 Hadamard SDK 终端 UI：

```bash
npx actoviq-tui [工作目录] [选项]

# 选项
#   --config <path>            加载指定的 Actoviq settings JSON 配置
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions（默认）
#   --model <model>            覆盖配置中的模型或分级别名
#   --resume <session-id>      恢复已保存的 Hadamard SDK 会话
#   --continue                 继续最近更新的会话
```

`actoviq-tui` 借鉴 Claude Code 的默认终端交互模式，但实现完全属于 Hadamard SDK：对话记录流式写入终端原生滚动缓冲区，底部可重绘区域承载状态行、Claude 风格 prompt bar、斜杠命令菜单和权限确认。

适合需要更完整终端体验的场景：

- 运行时状态：spinner、耗时、工具次数和当前工具，并在常驻模式行上展示「模型 · 权限预设 · 推理强度 · 当前团队」以及以窗口百分比表示的上下文用量。
- 多行编辑：行尾输入 `\` 再按 Enter，或使用 Ctrl+J；支持历史浏览和内联光标渲染。
- 斜杠命令菜单支持搜索。直接运行 `/resume` 会打开项目会话选择器，`/resume <session-id>` 可按 ID 直接恢复。
- `@` 文件补全：输入 `@` 弹出基于 git 的工作区文件选择器；`↑↓` 选择、`Tab`/`Enter` 插入路径。
- `/team`、`/workflows`、`/worktree` 会打开选择面板——将已保存的 Model Team（或「无团队」）激活为可调用工具、运行已保存的动态工作流，或进入/退出/列出 git worktree；直接的 `list`/`ask`/`run`/`enter` 形式同样可用。
- `/model` 用于选择模型；`/model config` 可配置提供商、隐藏显示的 API key、base URL 和模型分级；`/effort` 用于选择推理强度。
- `/skills`、`/agents`、`/mcp` 和 `/plugins` 用于浏览 Hadamard SDK 能力目录；`/help` 搜索命令用法，`/dream` 控制 dream 运行。
- 运行中追加指令：Agent 工作时继续输入并按 Enter，消息会排队注入下一次模型请求。
- `/permissions` 可在只读、工作区访问、完全访问、计划模式预设之间切换；使用 `--permission-mode default` 时，变更型工具会弹出 批准 / 始终允许 / 拒绝 确认，且「始终允许」规则会随会话保存。只读 Bash 命令（`ls`、`git status`…）会自动放行。
- `/plan` 进入计划模式（研究后提议：Agent 调用 EnterPlanMode/ExitPlanMode，写出计划文件，你审批）；`/init` 生成 `CLAUDE.md`；`/context`、`/cost`/`/usage`、`/doctor` 分别查看上下文窗口、花费与配置。
- `/output-style` 选择简洁/解释/学习等回复风格；`/hooks` 列出已配置的 PreToolUse 钩子（settings.json）；`/mcp add`/`/mcp remove` 管理 stdio MCP 服务器（~/.actoviq/mcp.json）。
- Esc 中止当前运行；Ctrl+C 清空输入，快速连按两次退出。

`actoviq-react` 和 `actoviq-tui` 使用同样的 Hadamard SDK 默认值：`~/.actoviq/settings.json`、当前工作区核心工具、`bypassPermissions`，以及未显式配置时不限工具迭代次数。

未显式配置 `sessionDirectory` 时，会话按工作区隔离保存在 `~/.actoviq/projects/<workspace-key>`。

GUI、TUI、CLI 当前走 `createAgentSdk()` 交互入口；它们与模块化 Runtime 属于同一个 Hadamard SDK 仓库，但交互入口会额外组合 sessions、skills、memory、MCP、worktrees、teams 等产品能力。

## 6. 桌面 GUI 快速上手

在仓库中启动开发版 GUI：

```bash
npx actoviq-gui .
```

打包桌面版启动后，推荐按这个顺序使用：

1. 在 Projects 中打开主工作目录。项目详情顶部的工作路径选择器可以为同一项目添加多个目录；切换活动路径后，文件树、终端、Git 和 Agent 的当前目录随之切换，但项目仍使用同一组会话。
2. 在输入框右下角点击模型胶囊。一级菜单列出全部 Configurations 和 Agents；指向或打开一项后，在右侧面板选择具体模型与 Reasoning 强度。
3. 需要先调查再改代码时，使用 `/plan`。Plan 模式会阻止未确认的变更；确认方案并退出 Plan 后再执行。
4. 对长任务使用 `/goal <目标>`，随后用不带参数的 `/goal` 查看状态；`/goal pause|resume|clear` 控制生命周期。Goal 是持续执行约束，不等同于待办列表，完成状态必须由带证据的 runtime `UpdateGoal` 提交。
5. 在 Project 区进入 Chats，可跨已登记项目搜索、筛选、置顶、重命名、归档和恢复 Session。Agent 子会话默认隐藏，需要时切换类型筛选，并从 Agent Monitor 查看。
6. Global Assistant 或 Project Manager 生成 Team Proposal 时，先 Preview。只有校验通过且点击 Apply 后才写入 Team 定义；Reject 不修改磁盘。

自动更新位于 Settings。开发版会明确显示不支持；安装版中点击 Check 检查版本，点击 Upgrade 下载并校验发布产物，刷新运行状态后自动重启到新版本。运行中的会话或未保存状态会阻止直接重启。

项目多工作路径的边界是“同一个逻辑项目的多个根目录”，不是把任意磁盘目录变成全局可写区。每次只有一个活动工作路径；新增路径不会移动或复制源文件，移除路径也不会删除文件。

## 7. 直接运行仓库示例

```bash
npm run example:actoviq-quickstart
```

对应文件：

- [examples/actoviq-quickstart.ts](../../examples/actoviq-quickstart.ts)

## 8. 一个最小可用的流式聊天机器人

下面这段代码就是一个可以直接拿来改的最小聊天机器人。你只要把自己的 JSON 配置路径接上，就可以在终端里持续聊天，并且保留同一个 session 的上下文。

```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  createAgentSdk,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

await loadJsonConfigFile('E:/configs/my-agent-config.json');

const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Simple Chat Bot' });
const rl = readline.createInterface({ input, output });

try {
  while (true) {
    const message = (await rl.question('你> ')).trim();
    if (!message || message === 'exit' || message === 'quit') {
      break;
    }

    const stream = session.stream(message);
    process.stdout.write('机器人> ');

    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        process.stdout.write(event.delta);
      }
    }

    const result = await stream.result;
    process.stdout.write(`\n[session=${session.id} stop=${result.stopReason}]\n\n`);
  }
} finally {
  rl.close();
  await sdk.close();
}
```

## 9. 下一步

继续阅读下一章，了解流式输出、会话和工具使用。

下一章：

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
