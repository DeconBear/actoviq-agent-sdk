# 03 — ReAct 循环

## 架构

ReAct 循环是核心 agent 执行引擎。它运行 `while(true)` 循环：将对话发送给模型 → 提取工具调用 → 执行工具 → 将结果反馈回去 → 重复直到模型返回纯文本响应。

位置：`src/runtime/conversationEngine.ts:90`

### 设计哲学

- **模型驱动终止**：当模型停止调用工具时循环结束
- **默认无限迭代**：`maxToolIterations = Infinity`（Hadamard Harness 原则——模型决定何时完成）
- **流式优先**：实时发送事件供 UI 消费者使用
- **错误韧性**：同一工具连续 3 次失败时中止循环

## 循环步骤

```
executeConversation(options)
    │
    ├── [初始化] 解析 model, effort, tools, messages
    │
    ├── [循环] while (true):
    │   ├── 1. 解析工具适配器（MCP + 本地）
    │   ├── 2. 构建 ModelRequest（系统提示词 + 消息 + 工具 + 参数）
    │   ├── 3. 发送给模型（流式或非流式）
    │   ├── 4. 提取 tool_use 块 → 如果没有 → 返回结果（循环结束）
    │   ├── 5. 执行工具（最多 10 个并发）
    │   │   a. 输入验证（Zod）
    │   │   b. 权限检查（decideActoviqToolPermission）
    │   │   c. 执行（adapter.execute）
    │   │   d. 追踪连续失败
    │   ├── 6. 推送 tool_result 块（tool_use_id 必须匹配）
    │   ├── 7. 检查停止条件（maxToolIterations? / 3 连败? / signal?）
    │   ├── 8. 需要时压缩上下文
    │   └── 9. 发送事件 + 继续循环
    │
    └── [返回] AgentRunResult
```

### 中断与错误处理

| 条件 | 行为 |
|---|---|
| `signal.aborted` | 抛出 `RunAbortedError` |
| 同一工具 3 次连续失败 | 中止循环（防止无限重试） |
| `max_tokens` 耗尽 | 最多重试 3 次，每次扩展 `maxTokens` |
| `maxToolIterations` 达到 | 停止循环（仅当显式配置时——默认 Infinity） |

### 常量

```typescript
const MAX_CONCURRENT_TOOL_USES = 10;       // 最大并行工具执行数
const TODO_REMINDER_INTERVAL = 10;         // Todo 快照间隔（迭代次数）
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3; // Token 耗尽最大重试次数
```

### 关键不变量

`tool_use_id` 必须在 assistant 消息的 `tool_use` 块和后续 user 消息的 `tool_result` 块之间匹配。这些位于**不同的消息**中。压缩系统通过 `extendPreserveToIncludeReferencedToolUses()` 防止此配对被破坏。
