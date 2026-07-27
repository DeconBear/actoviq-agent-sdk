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

**前缀稳定策略（对齐 Claude Code）：** 回合之间**不回写**历史 `tool_result`。滑动窗口清空会打断 DeepSeek 等自动前缀缓存。超大工具输出在**写入时**落盘归档；上下文压力靠整段摘要 compact。

**完全压缩**（对话中途 / 会话级）：超过 `autoCompactThresholdTokens`（默认 155K）时，用模型总结旧消息，保留最近消息（默认 8 条），注入摘要。会有一次有意的 cache miss，之后新前缀再稳定。

**Anthropic prompt cache：** 仅在 `*.anthropic.com` 上打 `cache_control` 断点。DeepSeek 等兼容端依赖其自动 Context Caching；`prompt_cache_hit_tokens` 会映射为本地的 `cache_read_input_tokens`。

```
上下文大小检查（每次模型请求前）
    │
    ├── < 阈值 → append-only（不改写历史）
    └── ≥ 阈值 → compactActoviqConversationIfNeeded()
        ├── 仅整段摘要 compact（microcompact 只作摘要输入预处理，不写回会话）
        └── 断路器：连续 3 次失败 → 停止压缩
```

`createAgentSdk` / `actoviq-react` 使用的会话级 `compactActoviqSession` 遵循同样规则。

### 工具结果归档

当工具结果超过 `toolResultArtifactMaxChars`（默认 80K）时，写入文件并替换为占位符（只影响当前结果，不回改更早消息）。
