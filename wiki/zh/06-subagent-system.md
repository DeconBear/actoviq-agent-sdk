# 06 — 子代理系统

## 架构

子代理是通过 `Agent`/`Task` 工具由父 agent 创建的独立执行的 agent 会话。它们可以在前台（阻塞）或后台（非阻塞，带通知注入）运行。

位置：`src/runtime/actoviqAgents.ts`, `src/runtime/agentClient.ts:2500-3000`, `src/runtime/actoviqBackgroundTasks.ts`

### 设计原则

- **每个子代理一个会话**：每个子代理获得独立的 `StoredSession`
- **继承上下文**：子代理从父代理继承权限模式、effort、hooks 和工具策略
- **通知驱动**：后台子代理将 `<task_notification>` XML 注入父代理的下一个模型请求——无需轮询
- **Worktree 隔离**：子代理可在隔离的 git worktree 中运行，防止文件冲突

## 委派架构

```
父会话
    │
    ├── Agent/Task 工具调用 { description, prompt, subagent_type, ... }
    │   ├── 前台（run_in_background: false）
    │   │   ├── 创建子 StoredSession
    │   │   ├── 构建 agent 专用系统提示词
    │   │   ├── 进程内运行 executeConversation()
    │   │   └── 返回结果 + 清理 worktree
    │   │
    │   └── 后台（run_in_background: true）
    │       ├── 创建子 StoredSession
    │       ├── 存入 BackgroundTaskStore
    │       ├── 启动非阻塞 Promise
    │       ├── 完成时 → 存储结果，排队通知
    │       └── 失败时 → 存储错误，排队通知
    │
    ├── SendMessage 工具
    │   ├── 运行中的 agent → 排队到 subagentInputQueues
    │   └── 已完成的 agent → 恢复会话，用消息重新运行
    │
    └── 共享状态（ActoviqAgentClient Maps）
```

### 后台任务生命周期

```
                   ┌─────────┐
                   │ running  │
                   └────┬─────┘
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │completed │ │  failed  │ │cancelled │
    └──────────┘ └──────────┘ └──────────┘
```

### 取消流程（TOCTOU 修复）

```typescript
async cancel(taskId: string): Promise<BackgroundTaskRecord> {
  const existing = await this.store.load(taskId);
  // 如果已处于终止状态 → 直接返回（不覆盖）
  if (existing.status === 'completed' || 'failed' || 'cancelled') return existing;
  
  this.abortControllers.get(taskId)?.abort();
  
  // 重新读取以避免 TOCTOU —— 任务可能在检查和 abort 之间完成
  const refreshed = await this.store.load(taskId);
  if (refreshed.status === 'completed' || 'failed' || 'cancelled') return refreshed;
  
  // 确认仍在运行 → 标记为 cancelled
  await this.store.save({ ...refreshed, status: 'cancelled' });
}
```

### Agent 定义

三个来源（在初始化时合并）：

1. **编程方式**：`createAgentSdk({ agents: [...] })`
2. **Markdown 文件**：`~/.actoviq/agents/*.md`（用户级）和 `.actoviq/agents/*.md`（项目级）
3. **内置**：`getDefaultActoviqAgents()` → Explore, Plan, general-purpose

Markdown 格式（frontmatter + body）：
```markdown
---
name: auditor
description: 审计代码，不嵌套委派
tools: Read, Grep, Glob
disallowedTools: Write, Edit
effort: high
permissionMode: plan
---
You are a project audit specialist.（你是一个项目审计专家。）
```

### 嵌套委派控制

| 控制项 | 默认值 |
|---|---|
| `maxSubagentDepth` | 1（一层：父→子，子不能再委派） |
| `maxSubagentFanout` | 8（最多 8 个并发子代理） |
| `allowedAgents` | undefined（允许全部） |
