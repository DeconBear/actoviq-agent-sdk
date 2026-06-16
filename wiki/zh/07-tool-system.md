# 07 — 工具系统

## 架构

工具是 SDK 的动作原语。每个工具是一个 `{ name, inputSchema, execute, prompt? }` 四元组。`tool()` 工厂将 Zod schema 封装为 JSON Schema，强制 `additionalProperties: false`。

### 设计原则

- **自描述**：每个工具声明其 schema、描述和可选的模型提示词
- **Zod 优先**：通过 Zod v4 进行输入验证，自动转换为 JSON Schema
- **默认严格**：`strictObject()` → `additionalProperties: false`
- **元数据丰富**：`isReadOnly`、`isDestructive`、`isConcurrencySafe`、`checkPermissions`、`interruptBehavior`

## 工具类别

| 类别 | 工具 | 关键特征 |
|---|---|---|
| **文件** | Read, Write, Edit, Glob, Grep | Write/Edit 强制读前写入 |
| **Shell** | Bash, PowerShell | 可配置超时，支持沙箱 |
| **Task** | TaskCreate, Update, List, Get, Output, Stop | 任务生命周期管理 |
| **Agent** | Agent, Task, SendMessage | 动态创建 |
| **Web** | WebFetch, WebSearch | 外部网络访问 |
| **交互** | AskUserQuestion, TodoWrite | 需要用户交互 |
| **元工具** | Config, ToolSearch, Skill, NotebookEdit | SDK 内省 |

## 执行流程

```
模型调用工具
    │
    ▼
1. 输入验证 → adapter.inputSchema.parse(toolUse.input)
    │
    ▼
2. 权限检查 → decideActoviqToolPermission(...)
    │  deny → ToolExecutionError
    │
    ▼
3. 执行 → adapter.execute(parsedInput, context)
    │
    ▼
4. 结果格式化
    • 成功 → { type: "tool_result", tool_use_id, content }
    • 错误 → { type: "tool_result", is_error: true, content }
    • 超大 → 截断到 maxResultSizeChars (默认 50K)
    │
    ▼
5. 推入对话 → { role: "user", content: [tool_result] }
```

## `tool()` 工厂

位置：`src/runtime/tools.ts:18`

```typescript
export function tool<Input, Output>(
  config: CreateToolOptions<Input, Output>,
  execute: AgentToolDefinition<Input, Output>['execute'],
): AgentToolDefinition<Input, Output> {
  assertPublicToolName(config.name);  // 仅允许字母数字 + _ -
  const inputJsonSchema = toInputJsonSchema(config.inputSchema, config.name);
  return {
    kind: 'local', name, description, inputSchema, inputJsonSchema,
    execute, strict: config.strict ?? true,
    isReadOnly, isDestructive, isConcurrencySafe, checkPermissions,
    aliases, interruptBehavior: config.interruptBehavior ?? 'block',
    maxResultSizeChars: config.maxResultSizeChars ?? 50_000,
    prompt: config.prompt,
  };
}
```

### 工具别名

工具可以声明别名。主要用例是 `Agent` 带别名 `Task` 以实现 Claude Code 兼容性。别名在适配器创建时展开。

### 文件工具：读前写入

Write 和 Edit 工具强制要求文件必须在当前会话中被读取过。这防止模型写入未经检查的文件。
