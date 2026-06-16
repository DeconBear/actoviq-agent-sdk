# 18 — Bridge SDK 与兼容

## 架构

Bridge SDK 提供兼容层，将第三方 agent 运行时（Claude Code）封装在与 Hadamard SDK 相同的 API 接口之后。这使得可以直接进行行为比较。

位置：`src/parity/*`

### 两个 Bridge 封装

| 封装 | 入口 | 用途 |
|---|---|---|
| `actoviqBridgeSdk` | `createActoviqBridgeSdk()` | 直接 bridge：启动 `bun vendor/actoviq-runtime/cli.js` |
| `actoviqCleanBridgeCompatSdk` | `createActoviqCleanBridgeSdk()` | 兼容 bridge：在 bridge 运行时之上的 Hadamard 风格 API |

### Bridge SDK 流程

```
createActoviqBridgeSdk()
    ├── 验证运行时 bundle 存在
    ├── 验证 bun 已安装
    └── ActoviqBridgeSdkClient
        ├── run(prompt) → 启动 bun 子进程
        │   ├── 传递：--prompt, --work-dir, --model, --permission-mode
        │   ├── 流式：stdout（SSE/文本事件）
        │   └── 解析：工具调用、结果、最终输出
        └── close() → 终止子进程
```

### 事件提取

```typescript
extractActoviqBridgeToolRequests(output) → ToolRequest[]
extractActoviqBridgeToolResults(output) → ToolResult[]
extractActoviqBridgeTaskInvocations(output) → TaskInvocation[]
getActoviqBridgeTextDelta(output) → string
```

### Bridge 局限性

| 功能 | Bridge 支持 |
|---|---|
| 工具执行 | 完整（通过子进程） |
| 子代理委派 | 部分（Bridge 自身的 agent 系统） |
| 会话持久化 | Bridge 自有格式 |
| 流式输出 | Bridge 输出解析 |
| 自定义工具 | 有限（仅 MCP） |
| 记忆/梦境 | 不可用 |
| Worktree 隔离 | Bridge 自身的 worktree 支持 |
