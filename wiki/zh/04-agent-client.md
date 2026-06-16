# 04 — Agent 客户端

## 架构

`ActoviqAgentClient` 是中央编排器。所有 SDK 操作都经过它。它是"上帝类"——~3820 行，12 个公开 API 接口，4 个共享可变状态 Map。

位置：`src/runtime/agentClient.ts:575`

## 方法组

**会话生命周期**（~900-1300 行）：
```
createSession(options) → AgentSession
resumeSession(id, options) → AgentSession
  ├── SessionStore.load()
  ├── 恢复权限上下文
  ├── 协调后台任务
  └── SessionManager.register()
```

**运行执行**（~1800-2200 行）：
```
run(prompt, options?) → AgentRunResult
stream(prompt, options?) → AgentRunStream
  ├── prepareRunAugmentations()
  │   ├── collectPendingTaskNotifications()
  │   ├── 注入 dream/记忆上下文
  │   └── 构建系统提示词
  ├── 解析模型（分级 → 具体 ID）
  ├── 解析工具（会话 + MCP + 选项）
  └── executeConversation()
```

**子代理委派**（~2500-3000 行）：
```
runWithAgent(agent, prompt, options?, delegation?)
launchBackgroundAgentTask(agent, prompt, ...)
  ├── requireAgentDefinition()
  ├── prepareDelegatedWorkspace()      (worktree 或 cwd)
  ├── extractInheritedDelegationOptions() (权限、effort、hooks)
  ├── 创建子会话
  ├── 前台执行或后台启动
  └── finalizeDelegatedWorkspace()     (清理干净的 worktree)
```

**上下文增强**（~2100-2800 行）：
```
prepareRunAugmentations(runId, input, options, session?)
  ├── 收集待处理的任务通知（XML 格式）
  ├── 注入 dream 整合结果
  ├── 注入相关记忆
  ├── 构建系统提示词（工具 + skills + 环境 + buddy）
  └── 应用模型分级解析
```

## 共享可变状态（耦合热点）

四个 Map 在并发子代理操作间共享，无锁：

```typescript
private readonly pendingDelegations = new Map<...>();          // 委派追踪
private readonly pendingRuntimeNotifications = new Map<...>(); // 通知队列
private readonly subagentInputQueues = new Map<...>();         // SendMessage 队列
private readonly sessionRuntimeOverrides = new Map<...>();     // 运行时覆盖
```

**风险**：await 边界处的异步交错可能导致 TOCTOU bug。
**缓解**：Node.js 单线程事件循环防止真正的并行竞争，但 async 交错仍然脆弱。

### `prepareRunAugmentations()` 流程

```typescript
private async prepareRunAugmentations(runId, input, options, session?) {
  // 1. 收集待处理的后台任务通知
  const taskNotifications = await this.collectPendingTaskNotifications(session?.id);
  // 2. 收集 dream 整合结果
  const dreamContext = await this.collectDreamContext(session);
  // 3. 收集相关记忆
  const memoryContext = await this.collectMemoryContext(session, input);
  // 4. 构建系统提示词
  const systemPrompt = await buildSystemPrompt({...});
  return { systemPrompt, prefixedMessages, model, ... };
}
```

### `routeMessageToAgent()` — SendMessage 实现

```typescript
private async routeMessageToAgent(target, message, context) {
  // 1. 通过 agent 名称、task ID 或 session ID 解析目标
  const resolved = await this.resolveAgentTarget(target);
  // 2. 检查 agent 是否正在运行
  if (running) {
    // 将消息排队，在下一个工具边界投递
    queue.push(message);
    return { status: 'queued', ... };
  }
  // 3. Agent 已停止 → 恢复会话并重新运行
  const task = await this.launchBackgroundOnSession(session, message);
  return { status: 'resumed', ... };
}
```

### 嵌套委派控制

| 控制项 | 来源 | 默认值 |
|---|---|---|
| `maxSubagentDepth` | 构造函数 | 1（一层） |
| `maxSubagentFanout` | 构造函数 | 8 |
| 按定义的 `allowedAgents` | Agent 定义 frontmatter | undefined（全部） |
