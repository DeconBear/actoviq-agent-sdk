# 01 — 入口与总览

## 架构设计

### 双 SDK 模型

本仓库提供两个 agent 运行时入口，共享相同的配置、工具和存储层：

```
                    ┌──────────────────────────┐
                    │   共享层                   │
                    │  • types.ts               │
                    │  • 配置解析                │
                    │  • 工具定义                │
                    │  • 存储（会话、任务、      │
                    │    检查点）                │
                    │  • MCP、钩子、权限         │
                    └──────┬──────────┬────────┘
                           │          │
              ┌────────────▼──┐  ┌───▼──────────────────┐
              │ Hadamard SDK  │  │ actoviq-bridge-sdk    │
              │               │  │                       │
              │ createAgentSdk│  │ createActoviqBridgeSdk│
              │ 进程内执行     │  │ 子进程（bun）          │
              │ ReAct 循环    │  │ 黑盒运行时              │
              └───────────────┘  └───────────────────────┘
```

**Hadamard SDK**（`createAgentSdk()`）：进程内执行。ReAct 循环（`conversationEngine.ts`）直接在 Node.js 中运行。所有 TypeScript 源码可修改。除 `zod` 和 `glob` 外无运行时依赖。

**actoviq-bridge-sdk**（`createActoviqBridgeSdk()`）：通过 `bun` 子进程运行预编译的运行时 bundle。作为参考实现和回退方案。bundle 内的 ReAct 循环不可修改。设 `directCli: true` 时则直接 spawn PATH 上的本地 `claude`（无需 bundle/Bun），复用官方原生 exe Claude Code；provider 隔离（`ANTHROPIC_*` 环境注入）两种模式都适用。

### Harness 设计哲学

> SDK 提供脚手架，不提供约束。模型做决策。

| 层 | SDK 提供 | 模型决策 |
|---|---|---|
| ReAct 循环 | 工具分发、结果收集 | 何时停止、调用什么工具 |
| 子代理 | 会话创建、通知路由 | 委派什么、多少个、何时查看结果 |
| 工作流 | `agent()`/`parallel()`/`pipeline()` 原语 | 脚本逻辑、迭代次数、收敛条件 |
| Model Team | 多模型分发、上下文积累 | 何时收敛、接受或拒绝什么反馈 |
| 权限 | 规则评估、允许/拒绝执行 | 是否询问用户 |

### 配置优先级链

```
CreateAgentSdkOptions  (编程方式，最高优先级)
    → process.env      (ACTOVIQ_* 环境变量)
    → settings.json    (~/.actoviq/settings.json → env 块)
    → 硬编码默认值     (provider=anthropic, maxTokens=32000, ...)
```

不自动检测 provider 或 baseURL。

## 模块设计

### 公开 API

`src/index.ts` 导出约 260 个符号，按类别组织：

| 类别 | 关键导出 |
|---|---|
| **入口** | `createAgentSdk`, `createActoviqBridgeSdk` |
| **配置** | `resolveRuntimeConfig`, `loadJsonConfigFile`, `loadDefaultActoviqSettings` |
| **运行时** | `ActoviqAgentClient`, `AgentSession`, `AgentRunStream` |
| **工具** | `tool()`, `createActoviqCoreTools`, `createActoviqFileTools`, `createBashTool` |
| **子代理** | `ActoviqAgentsApi`, `ActoviqBackgroundTaskManager`, `loadActoviqAgentDefinitions` |
| **工作流** | `WorkflowEngine`, `WorkflowBuilder`, `WorkflowApi` |
| **Swarm** | `ActoviqSwarmApi`, `ActoviqSwarmTeam`, `ActoviqSwarmTeammateHandle` |
| **记忆** | `ActoviqMemoryApi`, `ActoviqDreamApi` |
| **存储** | `SessionStore`, `MailboxStore`, `TeammateStore` |
| **工作区** | `ActoviqWorkspace`, `createGitWorktreeWorkspace` |
| **Bridge** | `ActoviqBridgeSdkClient`, `ActoviqCleanBridgeSdkClient` |
| **错误** | `ActoviqSdkError`, `ConfigurationError`, `SessionNotFoundError` 等 |

### 模块依赖图

```
src/index.ts (公开接口)
    │
    ├── config/*          (独立 — 为所有模块提供配置)
    ├── provider/*        (依赖 config)
    ├── runtime/*         (依赖 config, provider, tools, storage)
    │   ├── agentClient   (中央编排器)
    │   ├── conversationEngine (ReAct 循环)
    │   ├── agentSession  (会话封装)
    │   ├── actoviqAgents (子代理系统)
    │   └── ...
    ├── tools/*           (独立 — 纯函数 + Zod)
    ├── storage/*         (独立 — JSON 文件 I/O)
    ├── workflow/*        (依赖 agentClient)
    ├── swarm/*           (依赖 agentClient, storage)
    ├── memory/*          (依赖 storage, agentClient)
    ├── workspace/*       (独立 — git 操作)
    ├── hooks/*           (独立 — 函数组合)
    ├── mcp/*             (依赖 @modelcontextprotocol/sdk)
    ├── cli/*, tui/*      (依赖以上所有模块)
    └── parity/*          (依赖 agentClient, bridge bundle)
```

### 数据流：单次 `sdk.run()`

```
sdk.run(prompt)
    → createSession()           [SessionStore.create]
    → prepareRunAugmentations() [通知 + 记忆 + 系统提示词]
    → executeConversation()     [ReAct 循环: 模型 ↔ 工具]
    → resolveStopHooks()        [运行后钩子]
    → SessionStore.save()       [持久化消息]
    → return AgentRunResult     [{ text, toolCalls, requests, usage }]
```

## 代码细节

### 入口点：`createAgentSdk()`

位置：`src/runtime/agentClient.ts:3593`

```typescript
export async function createAgentSdk(
  options: CreateAgentSdkOptions = {},
): Promise<ActoviqAgentClient> {
  const config = await resolveRuntimeConfig(options);
  const store = new SessionStore(config.sessionDirectory);
  const backgroundTaskStore = new BackgroundTaskStore(config.sessionDirectory);
  // ... 解析工具、MCP、agent、skills、hooks ...
  return ActoviqAgentClient.create(config, store, /* ... */);
}
```

关键初始化步骤：
1. 解析配置（合并 options → env → settings.json → 默认值）
2. 创建存储层（SessionStore, BackgroundTaskStore, MailboxStore, TeammateStore）
3. 解析默认工具（核心 + 文件 + 用户提供的）
4. 解析 MCP 服务器
5. 加载 agent 定义（编程方式 + Markdown 文件）
6. 加载 skill 定义（内置 + 项目 + 用户）
7. 创建 McpConnectionManager
8. 实例化 `ActoviqAgentClient`

### `ActoviqAgentClient` — 接口概览

位置：`src/runtime/agentClient.ts:575`（~3820 行）

```
ActoviqAgentClient
├── 公开 API（只读属性）
│   ├── sessions: AgentSessionsApi      创建/恢复/列出/复制/删除
│   ├── agents: ActoviqAgentsApi         列出/获取/运行/后台启动
│   ├── skills: ActoviqSkillsApi         列出/获取/运行/流式
│   ├── tools: ActoviqToolsApi           获取工具/列出元数据
│   ├── tasks: ActoviqBackgroundTasksApi 列出/获取/等待/取消
│   ├── buddy: ActoviqBuddyApi           人格配置
│   ├── memory: ActoviqMemoryApi         读写记忆
│   ├── dream: ActoviqDreamApi           触发整合
│   ├── swarm: ActoviqSwarmApi           创建/管理 swarm
│   ├── context: ActoviqContextApi       上下文概览
│   ├── slashCommands: ActoviqSlashCommandsApi
│   └── workflow: WorkflowApi            DAG 引擎
│
├── 公开方法
│   ├── run(prompt, options?)           一次性：创建会话→运行→返回
│   ├── createSession(options?)          创建持久化会话
│   ├── resumeSession(id, options?)      恢复已有会话
│   ├── runWithAgent(agent, prompt)      使用 agent 定义运行
│   ├── listToolMetadata()               UI 工具目录
│   ├── getTool(name)                    按名称查找工具
│   └── close()                          清理：取消任务、断开 MCP
│
├── 私有状态（共享 Map — 耦合风险）
│   ├── pendingDelegations              Map<parentRunId, records[]>
│   ├── pendingRuntimeNotifications     Map<sessionId, notifications[]>
│   ├── subagentInputQueues             Map<agentId, messages[]>
│   └── sessionRuntimeOverrides         Map<sessionId, overrides>
│
└── 配置
    ├── config: ResolvedRuntimeConfig
    ├── maxSubagentDepth (默认 1)
    └── maxSubagentFanout (默认 8)
```

### `close()` — 优雅关闭

```typescript
async close(): Promise<void> {
  const errors: unknown[] = [];
  try { await this.backgroundTaskManager.cancelAll(); } catch (e) { errors.push(e); }
  try { this.sessionManager.dispose(); }              catch (e) { errors.push(e); }
  try { await this.mcpManager.closeAll(); }           catch (e) { errors.push(e); }
  if (errors.length > 0) throw new AggregateError(errors, '...');
}
```

每个清理步骤独立运行。失败被收集到 `AggregateError` 中——一个步骤的失败不会阻塞其他步骤。

### 设计不变量

1. Hadamard SDK 必须完全可开源（不依赖闭源运行时）
2. 工具 schema 使用 `z.strictObject()` → `additionalProperties: false`
3. `tool_use_id` 必须在消息之间的 tool_use 和 tool_result 中匹配
4. 最大工具迭代次数默认为 `Infinity`（不设人为上限）
5. 子代理权限默认为 `acceptEdits`
