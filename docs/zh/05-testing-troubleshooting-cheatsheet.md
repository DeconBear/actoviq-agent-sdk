# 05. 测试、排错与速查

这一章是日常开发和发布时最实用的维护手册。

## 1. 核心验证命令

在发版或提交 PR 之前，建议至少执行：

```bash
npm run typecheck
npm test
npm run build
npm run verify:package
npm run docs:build
npm pack --dry-run
```

如果改了 `/core`、`/providers`、`/runtime` 等公开职责 subpath，再执行：

```bash
npm run test:sdk-v2:coverage
npm run api:check
npm run package:check
```

`package:check` 会重新 build，并检查 package exports、公开 API snapshot、打包后导入和 `npm pack --dry-run`；因此它比单独的 typecheck 更接近发布门禁。

本地联调时还可以运行：

```bash
npm run smoke
npm run example:hadamard-quickstart
```

## 2. 常见问题

### 没有找到凭据

优先检查：

1. `~/.hadamard/settings.json`
2. 你是否先调用了 `loadJsonConfigFile(...)`
3. `HADAMARD_AUTH_TOKEN`
4. `HADAMARD_BASE_URL`

### 找不到 session

检查：

1. `session.id` 是否正确
2. `sessionDirectory` 是否被改过
3. 你是不是在另一个目录或另一个 `homeDir` 下创建了 session
4. 默认目录是否在 `~/.hadamard/projects/<workspace-key>`，而不是旧版全局目录
5. Runtime v2 是否注册了 `RuntimeServices.sessions`；只传 `sessionId` 不会自动创建存储

### 找不到工具

检查：

1. 你是否把工具传给了 `createAgentSdk(...)`
2. 你是否挂上了正确的 MCP server
3. Runtime v2 中 `AgentSpec.tools` 的名称是否存在于 `ToolRegistry`
4. 工具是否被 `ToolPolicy` deny 或 interrupt

### 找不到 skill

检查：

1. 它是 bundled、custom，还是从磁盘加载的 skill
2. skill 目录是否在搜索路径中

### dream 没有触发

检查：

1. 是否开启了 `autoDreamEnabled`
2. 是否已经累积了足够多的最近 session
3. 是否刚刚才做过一次 consolidation
4. lock 是否还在生效

### buddy 没有生效

检查：

1. 是否已经执行 `sdk.buddy.hatch(...)`
2. 是否被 `mute()` 掉了
3. 是否是在新的 SDK 实例里重新运行，导致状态还没初始化

### Provider 能调用，但某项能力被拒绝

模块化 provider 会在请求前执行 capability preflight。检查：

1. 模型是否支持 tools、parallel tool calls、structured output 或 reasoning
2. 自定义 compatible endpoint 是否通过 `capabilities` 显式声明真实能力
3. `ModelRegistry` 中 provider ID 与 `defaultModel.provider` 是否一致
4. 是否错误地把 OpenAI Chat-compatible endpoint 配成 OpenAI Responses adapter

### Bridge runtime 没有检测到

Hadamard SDK 本身不需要 Bridge。只有接外部 CLI 时才检查：

1. 对应 CLI 是否在 `PATH`
2. 是否设置 `HADAMARD_<PROVIDER>_PATH`
3. bundle 是否已通过 `npx hadamard-link-runtime` 链接
4. 详细排查见 [Bridge Runtime 附录](./bridge-runtime.md)

## 3. 常用示例命令

```bash
npm run example:hadamard-quickstart
npm run example:hadamard-session
npm run example:hadamard-stream-loop
npm run example:hadamard-skills
npm run example:hadamard-memory
npm run example:hadamard-dream
npm run example:hadamard-swarm
npm run example:profiles
```

## 4. API 速查

交互/兼容入口：

1. `createAgentSdk(...)`
2. `sdk.run(...)` / `sdk.stream(...)`
3. `sdk.createSession(...)` / `sdk.resumeSession(...)`
4. `sdk.skills.listMetadata()` / `sdk.runSkill(...)`
5. `session.extractMemory(...)` / `session.compact(...)`
6. `sdk.dreamState()` / `session.dream(...)`
7. `sdk.buddy.hatch(...)`
8. `sdk.swarm.createTeam(...)`

模块化 Runtime：

1. `new ModelRegistry([...providers])`
2. `new AgentRuntime({ models, tools, services, middleware })`
3. `runtime.run(agentSpec, input, options)`
4. `runtime.stream(agentSpec, input, options)`
5. `new ToolRegistry([...runtimeTools])`
6. `new RuntimeServices({ sessions, checkpoints, ... })`
7. `buildProfile(...)` / `runProfile(...)`
8. `new WorkflowGraph(...)`

## 5. ADR 是什么？

ADR 是 **Architecture Decision Record**，中文常译为“架构决策记录”。它不是教程、需求清单或会议纪要，而是一份短文档，用来回答：

1. 当时遇到了什么架构问题。
2. 考虑过哪些方案与约束。
3. 最终选择了什么，为什么。
4. 这个选择带来哪些后果，以及何时应重新评估。

典型文件名是 `ADR-0001-use-local-session-store.md`。状态通常为 `proposed`、`accepted`、`superseded`。ADR 应记录长期有效且影响多个模块的决定；临时实施步骤、竞品研究、迁移 runbook 和内部审计应放在本地忽略的 `plan/`，不应伪装成公开 ADR。

一个最小模板：

```md
# ADR-0001: 使用项目主路径作为 Session locator

- Status: accepted
- Date: 2026-07-30

## Context
一个逻辑项目允许多个工作路径，但 Session 必须聚合到同一项目。

## Decision
Session 存储始终以项目主路径定位，活动工作路径只记录在 turn 元数据。

## Consequences
切换工作路径不会分裂聊天历史；主路径变更需要显式迁移策略。
```
