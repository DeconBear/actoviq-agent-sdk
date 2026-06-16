# 09 — 上下文注入

## 架构

在每次模型请求前，SDK 会用额外上下文增强对话：后台任务通知、记忆、Dream 结果、工具提示词、Skill 提示词和环境信息。这是"上下文注入管道"。

位置：`src/runtime/agentClient.ts:2105`（`prepareRunAugmentations`）、`src/runtime/actoviqCompact.ts`

### 系统提示词构建

```
System Prompt = 
    用户提供的系统提示词（或默认值）
    + 工具提示词（从所有已注册工具收集）
    + Skill 提示词（匹配的 skills）
    + 记忆上下文（相关记忆，含新鲜度）
    + Dream 结果（整合输出）
    + Buddy 人格（如已配置）
    + 环境块（workDir, git 状态, 平台, 日期）
    + Todo 快照（每 10 次迭代）
```

### 通知注入

```
每次父模型请求前：
    collectPendingTaskNotifications(sessionId)
    ├── 消费 pendingRuntimeNotifications 队列
    ├── 扫描 BackgroundTaskStore 中的已完成任务
    ├── 格式化为 <task_notification> XML 块
    └── 作为 prefixedMessages 注入（在用户输入之前）
```

### 压缩系统

两种压缩模式：

**微压缩**（每次请求）：在每次 API 调用前修剪过大的工具结果。

**完全压缩**（对话中途）：当上下文超过 `autoCompactThresholdTokens`（默认 155K）时，通过模型总结旧消息，保留最近消息（默认 8 条），将摘要作为合成系统消息注入。

```
上下文大小检查（每次模型请求前）
    │
    ├── < 155K tokens → 无操作
    └── ≥ 155K tokens → compactActoviqConversationIfNeeded()
        ├── 微压缩：修剪旧工具结果
        ├── 完全压缩：总结 + 保留最近消息
        └── 断路器：连续 3 次失败 → 停止压缩
```

### 工具结果归档

当工具结果超过 `toolResultArtifactMaxChars`（默认 80K）时，写入文件并替换为占位符。
