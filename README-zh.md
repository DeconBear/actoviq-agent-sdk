# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [中文](./README-zh.md)

文档站地址：https://deconbear.github.io/actoviq-agent-sdk/

Actoviq Agent SDK 是一个实验性的 TypeScript Agent SDK，面向多工具、多会话、多代理工作流。当前项目以 Hadamard SDK 作为唯一公开主路径。

## 亮点

- **Model Team** — 4 种多模型协作模式（Panel/Router/Discussion/Executor-Reviewer），每成员独立 provider 配置，$ENV_VAR apiKey 解析，全局 AgentPool
- **Dynamic Workflows** — JS 脚本多 agent 编排，`agent()`/`parallel()`/`pipeline()` 原语，沙箱运行时，Schema 强制
- **Worktree 工具** — `EnterWorktree`/`ExitWorktree`，栈式 cwd，`.worktreeinclude`，PR checkout，非 Git VCS hooks
- **TavilySearch** — AI 优化网络搜索，纯 TypeScript，自动 key 检测
- **标准 Benchmark** — 自包含跑分框架，DeepSeek judge，HTML 看板，4 agent 对比
- **TUI/REPL**: `/workflows`、`/worktree`、`/team` 斜杠命令

这个项目参考并借鉴了 Claude Code、Codex、Deepagents 等优秀项目和运行时设计，但 Actoviq 仍然是一个独立维护的公开 SDK 项目，拥有自己的 API 表面和文档体系。

项目仍在持续开发中，API 和运行行为后续还会继续打磨。欢迎提交 Issue 和 PR。

## 安装

```bash
npm install actoviq-agent-sdk zod
```

本地示例默认读取：

```text
~/.actoviq/settings.json
```

如果你希望使用自定义 JSON 配置文件，也可以先调用 `loadJsonConfigFile(...)`。

## 快速启动

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

// 默认：Anthropic 协议
const sdk = await createAgentSdk();

// 或使用 OpenAI / OpenAI 兼容接口（DeepSeek、vLLM 等）
const sdk = await createAgentSdk({
  provider: 'openai',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
});

try {
  const result = await sdk.run('请用一句话做自我介绍。');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

运行仓库自带示例：

```bash
npm run example:actoviq-quickstart
npm run example:actoviq-agent-helpers
```

## CLI 交互式 REPL

安装包后，可以直接在终端启动交互式 REPL：

```bash
npx actoviq-react [工作目录]
```

这是一个基于 readline 的交互式 Agent，特点：
- 主终端缓冲区实时流式输出（支持原生滚动回看）
- Tab 补全斜杠命令，包括会话模型、权限、压缩与恢复控制
- ↑↓ 方向键浏览历史命令
- Ctrl+C 中止当前请求，连按两次退出

**注意：** `actoviq-react` 是一个轻量级滚动 REPL，**不是功能完整的 TUI**。它不使用 alternate screen buffer，不支持 ScrollBox 或富文本终端渲染。适合快速交互和调试。完整终端 UI 请使用下面的 `actoviq-tui`。

## 终端 UI（TUI）

`actoviq-tui` 是 Clean SDK 的完整终端 UI，借鉴 Claude Code REPL 的设计：对话记录直接打印进终端原生滚动缓冲区，底部动态区域承载状态行、Claude 风格 prompt bar、斜杠命令菜单和权限确认对话框。

```bash
npx actoviq-tui [工作目录] [选项]

# 选项
#   --config <path>            加载指定的 Actoviq settings JSON 配置
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions（默认）
#   --model <model>            覆盖配置中的模型
#   --resume <session-id>      恢复已保存的 Clean SDK 会话
#   --continue                 继续最近更新的会话
```

功能特性：

- **原生滚动条流式转录** —— 助手文本、`⏺ 工具(参数)` 调用行和 `⎿ ✓/✗` 结果行直接写入终端缓冲区，滚动回看和复制粘贴照常可用。
- **实时状态行** —— 运行中显示 spinner、耗时、工具次数、上下文规模估计和当前工具名。
- **Claude 风格 prompt bar** —— 行尾输入 `\` 再按 `Enter`（或 `Ctrl+J`）换行；`↑`/`↓` 浏览历史；光标内联渲染。
- **斜杠命令菜单** —— 输入 `/` 弹出过滤菜单（`↑↓` 选择、`Tab` 补全、`Enter` 执行）。直接运行 `/resume` 会打开可搜索的项目会话选择器，`/resume <session-id>` 仍可按 ID 直接恢复。
- **运行时能力目录** —— `/skills`、`/agents`、`/mcp` 和 `/plugins` 用于浏览当前工作区可见的 Clean SDK 能力；`/help` 提供可搜索的命令说明。
- **模型与推理强度** —— `/model` 打开模型选择器，`/model config` 可配置提供商、隐藏显示的 API key、base URL 和 `min`/`medium`/`max` 模型分级；`/effort` 可选择 `low`、`medium`、`high`、`max` 或交给提供商自动决定。
- **Dream 控制** —— `/dream` 打开运行/状态选择器，也可以直接使用 `/dream run` 和 `/dream status`。
- **运行中追加指令（steering）** —— Agent 工作时可以继续输入并按 `Enter`：消息进入队列（显示 `⧗ queued`），并在下一次模型请求时注入。
- **权限对话框** —— 使用 `--permission-mode default` 时，变更型工具会暂停并弹出 批准 / 始终允许 / 拒绝 对话框。“始终允许”规则会随会话保存并在恢复时继续生效。
- **中断控制** —— `Esc` 中止当前运行；`Ctrl+C` 清空输入（连按两次退出）；空输入时 `Ctrl+D` 退出。
- **内置上下文管理** —— Clean SDK 会在长会话中自动压缩上下文，并在服务端拒绝超长请求时反应式压缩恢复；压缩以 `∿ context compacted` 提示呈现。

两个 CLI 共享同样的 Clean SDK 运行时默认值（`~/.actoviq/settings.json` 配置、核心工具、`bypassPermissions`、不限工具迭代次数），可对接任何 Anthropic 兼容或 OpenAI 兼容的模型服务。

默认情况下，Clean SDK 会话按当前工作区隔离保存在 `~/.actoviq/projects/<workspace-key>`。显式设置的 `sessionDirectory` 仍具有最高优先级。

模型分级使用与提供商无关的别名。通过 `ACTOVIQ_DEFAULT_MIN_MODEL`、`ACTOVIQ_DEFAULT_MEDIUM_MODEL` 和 `ACTOVIQ_DEFAULT_MAX_MODEL` 配置后，可以在任何模型选择位置使用 `min`、`medium` 或 `max`。

## 教程入口

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- 中文教程: [docs/zh/README.md](./docs/zh/README.md)
- GitHub Pages 文档站：
  - https://deconbear.github.io/actoviq-agent-sdk/

推荐从这里开始上手：

- [examples/actoviq-quickstart.ts](./examples/actoviq-quickstart.ts)
- [examples/actoviq-workflow.ts](./examples/actoviq-workflow.ts)
- [examples/actoviq-agent-helpers.ts](./examples/actoviq-agent-helpers.ts)

## 欢迎贡献

欢迎贡献代码、文档和示例。如果你发现问题或教程缺口，都欢迎提 Issue 或直接发 PR。

项目采用 [MIT License](./LICENSE)。
