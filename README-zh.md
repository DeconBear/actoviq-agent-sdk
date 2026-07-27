# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [中文](./README-zh.md)

文档站地址：https://deconbear.github.io/actoviq-agent-sdk/

**Actoviq**（`0.4.x`）是 TypeScript agent SDK 与 agent-team 平台，含 TUI、GUI、Bridge 与多 agent 协作。未来的 **1.0** 线将稳定 package subpath 契约；该表面**尚未发布**。

> **说明：** 桌面端 **Agent graph** 编排 UI（可视化团队 / 图编辑器）**仍在持续迭代与优化中**，交互与行为可能变化。生产工作流请优先使用 `/team`、已保存的 team 定义，以及 SDK 的 `createTeam()` / graph runtime。详见 `CHANGELOG.md`。

受 Claude Code、Codex、Deepagents 等项目启发。Actoviq 保持独立，拥有自己的公开 API 与文档。

## 愿景

- **多 agent**：子代理委派（Task 工具）、panel-analysis 团队、reviewer-auditor 对、动态 workflow —— agent 之间协作，而非单一的 ReAct 循环。
- **多运行时状态管理**：bridge config 明确区分两种模式。`Direct API` 在进程内调用 Anthropic/OpenAI 兼容接口；`External CLI` 则把已安装的 Claude Code、Codex、Pi、CodeWhale、Reasonix 或 Crush 作为子进程托管，并在 CLI 协议提供会话 ID 时保留原生 session 身份。
- **model team 协作**：leader 将每轮分派给最佳 specialist（`/model router`），panel 成员并行调查并收敛，reviewer 只报告可验证的问题 —— team 是 agent 可调用的一等工具。

## 亮点

- **Model Team** — `panel-analysis`（并行调查 + 收敛）和 `reviewer`（只报告可验证问题的审计者）。runtime-owned 成员池、流式 `TeamEvent`、成员 provider 配置，以及继承的权限/重试边界。
- **Model Router / Leader-Dispatch** — 每轮由 leader 分派到最佳 specialist（任意模型/提供商），执行者自身也可召集 team。Profile 位于 `~/.actoviq/routers/`。
- **Dynamic Workflows** — 显式信任等级的 JS 编排：trusted 兼容执行、隔离 local-process，或由 host 提供的远程/container 强 sandbox；local process 不宣传为对抗性多租户沙箱。
- **Bridge（命名运行时配置）** — 可选 `Direct API` 做 provider/API 级复用，也可选 `External CLI` 直接启动已安装的 Claude Code、Codex、Pi、CodeWhale、Reasonix 或 Crush，继承各 CLI 的原生登录和配置、流式显示规范化后的工具与回答事件、终止后台任务，并浏览/恢复受支持的原生会话。单独填写的 key 只注入子进程，不写入 CLI 的凭据库；Pi、CodeWhale、Reasonix 与 Crush 会使用按配置隔离的持久会话目录，因此 key 模式重启后仍可读取历史，同时不会读取原生登录凭据。
- **桌面 GUI (`actoviq-gui`)** — Electron 聊天 UI：流式 transcript、对话历史、命令面板、设置、每工具权限提示。安全增强。可视化 **Agent graph** 编排 UI 仍在迭代中，暂勿当作稳定产品面。
- **TUI (`actoviq-tui`)** — 终端 UI，25+ 斜杠命令，Claude Code 风格 UX：`/team`、`/bridge`、`/plan`、`/hooks`、`/mcp`、`/review`、`/context`、`/cost`、`/doctor` 等。实时状态旋转器、滚动 transcript、todo 面板、项目/用户级权限对话框、子命令自动补全。
- **计划模式 + hooks** — `EnterPlanMode`/`ExitPlanMode` 工具 + 计划文件；`settings.json` 中的 `PreToolUse`/`PostToolUse`/`SessionStart` hooks。
- **Worktree 工具** — `EnterWorktree`/`ExitWorktree`，栈式 cwd，`.worktreeinclude`，PR checkout。
- **TavilySearch** — AI 优化网络搜索，纯 TypeScript。
- **Standard Benchmark** — 自包含框架，DeepSeek judge，HTML dashboard，4-agent 对比。

## 1.0 SDK 架构

- `core`：不可变 `AgentSpec`、canonical items、structured output、guardrail、usage 与 run error。
- `providers`：统一 `ModelProvider` contract，以及 capability-checked OpenAI Responses、OpenAI Chat-compatible、Anthropic adapter。
- `runtime`：单一 `AgentRuntime`、lazy `RuntimeServices`、固定阶段 middleware、tool/policy、有界 stream、checkpoint、interruption/resume。
- `node`：tenant-scoped SQLite session/checkpoint/memory/artifact store 与 backup-first JSON v1 migration。
- `events` / `surfaces`：版本化、可 trace 的 `RunEvent`，以及统一 CLI/TUI/GUI/Bridge 语义和 redaction。
- `orchestration` / `workflow` / `profiles`：agent-as-tool、handoff、durable spawn、graph/preset、workflow trust 与六类 profile。
- `compat`：0.x root façade 与迁移 adapter，在整个 1.x 保留。

## 路线图 — 迈向 agent team

- **Swarm 协作** — 基于邮箱的 agent 间通信、任务队列、共享知识图谱。
- **持久 team 记忆** — team 级上下文，跨会话和成员变更保留。
- **跨运行时会话延续** — 恢复 bridge 运行时会话时保留精确位置。
- **Model team IDE** — 可视化团队构建器、成员角色编辑器、团队健康仪表板。

## 安装

要求 Node.js 22.13+ 或 Node.js 24。Node 22.5–22.12 的 `node:sqlite` 仍要求宿主进程 flag，
因此不属于默认 Runtime 支持范围。

```bash
npm install actoviq-agent-sdk zod
```

本地使用，请将配置放在：

```text
~/.actoviq/settings.json
```

也可以使用 `loadJsonConfigFile(...)` 预加载自定义 JSON 文件。

## 快速开始（1.0 runtime）

```ts
import type { AgentSpec } from 'actoviq-agent-sdk/core';
import { ModelRegistry, OpenAIResponsesProvider } from 'actoviq-agent-sdk/providers';
import { AgentRuntime } from 'actoviq-agent-sdk/runtime';

const runtime = new AgentRuntime({
  models: new ModelRegistry([
    new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY }),
  ]),
});
const agent: AgentSpec = {
  id: 'concise-chat',
  name: 'Concise chat',
  instructions: '请用一句话回答。',
  model: 'openai-responses:gpt-4.1-mini',
};

try {
  const result = await runtime.run(agent, '什么是 CAS？');
  console.log(result.output, result.usage.totalTokens);
} finally {
  await runtime.close();
}
```

0.x 应用可继续从 package root 或 `/compat` 导入 `createAgentSdk`。新应用应使用上述职责 subpath；迁移步骤见 [1.0 迁移指南](./docs/zh/09-sdk-v2-migration-guide.md)。

运行仓库示例：

```bash
npm run example:actoviq-quickstart
npm run example:actoviq-agent-helpers
npm run example:profiles
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

特性与英文 README 一致，包括上下文管理（append-only 前缀以利于 DeepSeek 等自动缓存；超阈值走整段摘要 compact）、bridge config、计划模式、hooks、MCP、诊断等。六种 External CLI 都可使用 `/bridge status`、`/bridge background`、`/bridge runs` 和 `/bridge stop`；`/bridge history` 与 `/bridge resume` 在 TUI 和 GUI 中共享同一套校验逻辑，但原生历史/恢复能力仍取决于已安装 CLI 的协议与版本。

## 桌面 GUI (`actoviq-gui`)

```bash
npx actoviq-gui [工作目录] [选项]
```

- Project 详情提供 `Document` / `Issues` 双 Tab。Issue 支持优先级、标签、验收标准、评论，以及受守卫保护的 `backlog → todo → in_progress → in_review/blocked → done` 生命周期。
- **Agent graph 编排 UI**（GUI **Agent** 区域的可视化团队/图编辑器）**仍在持续迭代和优化中**，请勿当作已定稿产品面；稳定工作流请用已保存 team + `/team` / SDK API。
- Settings → Models & routing 可创建 Agent Profile，将 bridge config 与模型绑定。`/issues start <id> [agent-profile]` 会先让 Project Manager 生成任务书，再创建关联会话；执行 agent 通过 `IssueReport` 汇报待审或阻塞状态。
- Issue 与会话可双向跳转。Issue 默认保存在 `<data-root>/projects/<workspace-key>/issues.json`，也可切换到受保护的工作区文件 `.actoviq/issues.json`。
- Settings → General 可将完整数据根目录迁移到空目录：复制并校验数据、写入 bootstrap 指针、重建 SDK/session store，并保留旧目录供手动清理。

数据根目录解析优先级为：显式 SDK `homeDir` → `ACTOVIQ_HOME` → `~/.actoviq/data-root.json` → `~/.actoviq`。

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
- [examples/profiles/all-profiles.ts](./examples/profiles/all-profiles.ts)

架构与运维文档：

- [架构审计与实施规划](./docs/zh/08-sdk-architecture-audit-and-optimization-plan.md)
- [1.0 迁移指南](./docs/zh/09-sdk-v2-migration-guide.md)
- [支持、安全、SemVer 与 failure model](./docs/zh/10-support-security-semver-and-failure-model.md)
- [JSON v1 → SQLite 迁移 Runbook](./docs/zh/11-json-v1-to-sqlite-migration-runbook.md)
- [1.0 实施与端到端验收报告](./docs/zh/12-sdk-1.0-implementation-and-verification-report.md)
- [安全报告政策](./SECURITY.md)

## 参与贡献

欢迎贡献。发现问题或文档缺失，请提交 Issue 或 Pull Request。

基于 [MIT License](./LICENSE) 许可。
