# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [中文](./README-zh.md)

文档站地址：https://deconbear.github.io/actoviq-agent-sdk/

**Actoviq** 是一个 agent team 平台 —— 一个 TypeScript 框架，用于将多个 AI agent、运行时和提供商组合成协作的多 agent 系统。它起源于可编程 agent SDK，但现在的目标是解决 **多 agent、多运行时状态管理** 和 **model team 协作**：协调多个专用模型、跨提供商路由、以及使用共享上下文编排 agent 集群。

受 Claude Code、Codex、Deepagents 等项目启发。Actoviq 保持独立，拥有自己的公开 API 与文档。

## 愿景

- **多 agent**：子代理委派（Task 工具）、panel-analysis 团队、reviewer-auditor 对、动态 workflow —— agent 之间协作，而非单一的 ReAct 循环。
- **多运行时状态管理**：bridge config 支持预配置多个后端（anthropic / openai / 任意兼容）的 apiKey + baseURL + model，命名切换，对话上下文在切换中保留（同一个 session 对象、同一份 transcript）。
- **model team 协作**：leader 将每轮分派给最佳 specialist（`/model router`），panel 成员并行调查并收敛，reviewer 只报告可验证的问题 —— team 是 agent 可调用的一等工具。

## 亮点

- **Model Team** — `panel-analysis`（并行调查 + 收敛）和 `reviewer`（只报告可验证问题的审计者）。集中化运行时（`src/team/teamRuntime.ts`），每个成员有稳定身份，流式 `TeamEvent`，每成员独立 provider 配置，全局 AgentPool。
- **Model Router / Leader-Dispatch** — 每轮由 leader 分派到最佳 specialist（任意模型/提供商），执行者自身也可召集 team。Profile 位于 `~/.actoviq/routers/`。
- **Dynamic Workflows** — JS 脚本多 agent 编排：`agent()`/`parallel()`/`pipeline()` 原语，沙箱运行时，Schema 强制。
- **Bridge（命名连接配置）** — 进程内运行时切换：预配置 `anthropic`/`openai` 后端，命名 + apiKey + baseURL + model，命名切换，多轮上下文保留。`/bridge config` 单页编辑器；`/bridge` 列出已保存配置；`/cost` 中按配置展示用量。
- **桌面 GUI (`actoviq-gui`)** — Electron 聊天 UI：流式 transcript、对话历史、命令面板、设置、每工具权限提示。安全增强。
- **TUI (`actoviq-tui`)** — 终端 UI，25+ 斜杠命令，Claude Code 风格 UX：`/team`、`/bridge`、`/plan`、`/hooks`、`/mcp`、`/review`、`/context`、`/cost`、`/doctor` 等。实时状态旋转器、滚动 transcript、todo 面板、项目/用户级权限对话框、子命令自动补全。
- **计划模式 + hooks** — `EnterPlanMode`/`ExitPlanMode` 工具 + 计划文件；`settings.json` 中的 `PreToolUse`/`PostToolUse`/`SessionStart` hooks。
- **Worktree 工具** — `EnterWorktree`/`ExitWorktree`，栈式 cwd，`.worktreeinclude`，PR checkout。
- **TavilySearch** — AI 优化网络搜索，纯 TypeScript。
- **Standard Benchmark** — 自包含框架，DeepSeek judge，HTML dashboard，4-agent 对比。

## 路线图 — 迈向 agent team

- **Swarm 协作** — 基于邮箱的 agent 间通信、任务队列、共享知识图谱。
- **持久 team 记忆** — team 级上下文，跨会话和成员变更保留。
- **跨运行时会话延续** — 恢复 bridge 运行时会话时保留精确位置。
- **Model team IDE** — 可视化团队构建器、成员角色编辑器、团队健康仪表板。

## 安装

```bash
npm install actoviq-agent-sdk zod
```

本地使用，请将配置放在：

```text
~/.actoviq/settings.json
```

也可以使用 `loadJsonConfigFile(...)` 预加载自定义 JSON 文件。

## 快速开始

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

// 默认 Anthropic 协议
const sdk = await createAgentSdk();

// 或使用 OpenAI / OpenAI 兼容 API
const sdk = await createAgentSdk({
  provider: 'openai',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
});

try {
  const result = await sdk.run('简要介绍一下你自己。');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

运行仓库示例：

```bash
npm run example:actoviq-quickstart
npm run example:actoviq-agent-helpers
```

## CLI REPL

安装包后，可以直接从终端启动交互式 scrollback 模式 REPL：

```bash
npx actoviq-react [工作目录]
```

## 终端 UI (TUI)

`actoviq-tui` 是全功能终端 UI，模拟 Claude Code 的 REPL 设计:

```bash
npx actoviq-tui [工作目录] [选项]

# 选项
#   --config <路径>            加载指定的 Actoviq 设置 JSON 文件
#   --permission-mode <模式>   default | acceptEdits | plan | bypassPermissions (默认)
#   --model <模型>             覆盖已配置的模型
#   --resume <会话ID>          恢复已存储的 Hadamard SDK 会话
#   --continue                 继续最近更新的会话
```

特性与英文 README 一致，包括上下文管理、bridge config、计划模式、hooks、MCP、诊断等。

## 桌面 GUI (`actoviq-gui`)

```bash
npx actoviq-gui [工作目录] [选项]
```

## 开发者笔记

- **启动 CLI/GUI 前构建：** `npm run build`（clean + `tsc`）。仅类型检查用 `npm run typecheck`；运行测试套件用 `npm test -- --run`。
- **Team 行为集中化：** 通过 `src/team/teamRuntime.ts` 扩展团队，而非在每个模式中重复逻辑。
- **Router profile 是 leader/dispatch 配置：** 内置 `dispatch` profile；用户同名文件会覆盖内置。
- **`CLAUDE.md` 在此仓库中默认 git-ignore**。

## 教程

- 英文教程：[docs/en/README.md](./docs/en/README.md)
- 中文教程：[docs/zh/README.md](./docs/zh/README.md)
- GitHub Pages 文档站：https://deconbear.github.io/actoviq-agent-sdk/

入口示例：
- [examples/actoviq-quickstart.ts](./examples/actoviq-quickstart.ts)
- [examples/actoviq-workflow.ts](./examples/actoviq-workflow.ts)
- [examples/actoviq-agent-helpers.ts](./examples/actoviq-agent-helpers.ts)

## 参与贡献

欢迎贡献。发现问题或文档缺失，请提交 Issue 或 Pull Request。

基于 [MIT License](./LICENSE) 许可。
