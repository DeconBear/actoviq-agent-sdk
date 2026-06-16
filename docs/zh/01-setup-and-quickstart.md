# 01. 环境准备与快速启动

这一章的目标很简单：尽快把 SDK 跑起来。

## 1. 安装

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

SDK 支持两种协议。在 `createAgentSdk()` 中设置 `provider`（默认 `'anthropic'`）。

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

SDK 自动处理协议转换。无论选择哪种协议，所有 API（`sdk.run()`、`session.send()`、`workflow`、`parallel()` 等）的使用方式完全一致。

## 3. 第一个 SDK 调用

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

- 运行时状态：spinner、耗时、工具次数、上下文规模估计和当前工具。
- 多行编辑：行尾输入 `\` 再按 Enter，或使用 Ctrl+J；支持历史浏览和内联光标渲染。
- 斜杠命令菜单支持搜索。直接运行 `/resume` 会打开项目会话选择器，`/resume <session-id>` 可按 ID 直接恢复。
- `/model` 用于选择模型；`/model config` 可配置提供商、隐藏显示的 API key、base URL 和模型分级；`/effort` 用于选择推理强度。
- `/skills`、`/agents`、`/mcp` 和 `/plugins` 用于浏览 Hadamard SDK 能力目录；`/help` 搜索命令用法，`/dream` 控制 dream 运行。
- 运行中追加指令：Agent 工作时继续输入并按 Enter，消息会排队注入下一次模型请求。
- 使用 `--permission-mode default` 时启用交互式权限确认；“始终允许”规则会随会话保存。
- Esc 中止当前运行；Ctrl+C 清空输入，快速连按两次退出。

`actoviq-react` 和 `actoviq-tui` 使用同样的 Hadamard SDK 默认值：`~/.actoviq/settings.json`、当前工作区核心工具、`bypassPermissions`，以及未显式配置时不限工具迭代次数。

未显式配置 `sessionDirectory` 时，会话按工作区隔离保存在 `~/.actoviq/projects/<workspace-key>`。

## 6. 直接运行仓库示例

```bash
npm run example:actoviq-quickstart
```

对应文件：

- [examples/actoviq-quickstart.ts](../../examples/actoviq-quickstart.ts)

## 7. 一个最小可用的流式聊天机器人

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

## 8. 下一步

继续阅读下一章，了解流式输出、会话和工具使用。

下一章：

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
