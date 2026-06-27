# 18 — Bridge SDK 与兼容

## 架构

Bridge SDK 提供兼容层，将第三方 agent 运行时（Claude Code）封装在与 Hadamard SDK 相同的 API 接口之后。这使得可以直接进行行为比较。

位置：`src/parity/*`

### 两个 Bridge 封装

| 封装 | 入口 | 用途 |
|---|---|---|
| `actoviqBridgeSdk` | `createActoviqBridgeSdk()` | 直接 bridge：以 **bundle 模式**（`bun vendor/actoviq-runtime/cli.js`）或 **directCli 模式**（PATH 上的本地 `claude`，无需 bundle/Bun）启动运行时 |
| `actoviqCleanBridgeCompatSdk` | `createActoviqCleanBridgeSdk()` | 兼容 bridge：在 bridge 运行时之上的 Hadamard 风格 API |

### Bridge SDK 流程

```
createActoviqBridgeSdk()
    │
    ├── directCli: false（默认）── bundle 模式
    │     ├── 验证运行时 bundle 存在
    │     └── 验证 bun 已安装
    │
    ├── directCli: true ── directCli 模式
    │     └── 在 PATH 上解析本地 `claude`（或 options.executable）；无需 bundle/Bun
    │
    └── ActoviqBridgeSdkClient（directCli 标志决定 spawn 形式）
        ├── createSession() → ActoviqBridgeSession
        ├── run(prompt) → 启动子进程
        │   ├── bundle：    `bun cli.js -p <prompt> --output-format stream-json …`
        │   ├── directCli： `claude -p <prompt> --output-format stream-json …`
        │   ├── 注入 ANTHROPIC_* 环境变量（settings.json → 子进程）── 两种模式都做
        │   ├── 流式：stdout（stream-json 事件）
        │   └── 解析：工具调用、结果、最终输出
        └── close()

### 执行模式：Bundle 与 directCli

`createActoviqBridgeSdk()` 通过 `directCli` 选项在两种模式下 spawn 运行时。两者共用相同的 `stream-json` 协议与相同的 `ANTHROPIC_*` 环境注入链，因此 provider 隔离行为完全一致。

| 模式 | `directCli` | spawn 的进程 | 依赖 |
|---|---|---|---|
| Bundle（默认） | `false` | `bun vendor/actoviq-runtime/cli.js -p …` | Bun + `runtime.bundle.br`（用 `actoviq-link-runtime` 链接） |
| directCli | `true` | `claude -p …`（PATH 解析，或 `executable`） | PATH 上有本地 `claude` —— 无需 bundle、无需 Bun |

directCli 模式与 multica 的 "shell out by name" 一致：bridge 在 PATH 上找到 `claude`，以标准参数 `-p --output-format stream-json --verbose …` 启动它。它是复用官方**原生 exe** Claude Code 的方式——后者不附带 `runtime.bundle.br`，因此无法被链接。

```typescript
// directCli 模式 —— 直接复用本地安装的 claude
const sdk = await createActoviqBridgeSdk({ directCli: true, workDir });
// spawn：claude -p "<prompt>" --output-format stream-json --verbose ...
//   executable 默认在 PATH 上找 `claude`；纯二进制时 cliPath 不用，
//   但 node+脚本组合仍会把 cliPath 前置。

// bundle 模式（默认）—— 仓库自带的运行时
const sdk2 = await createActoviqBridgeSdk({ workDir });
// spawn：bun vendor/actoviq-runtime/cli.js -p "<prompt>" --output-format ...
```

**Provider 隔离（两种模式都适用）：** spawn 之前，`buildChildEnvironment` 会把 `~/.actoviq/settings.json` 映射为 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 并注入子进程，覆盖子进程自身的 `~/.claude/settings.json`。因此交互式 `claude` 可继续走 Claude 官方，而 bridge 的子进程跑在 DeepSeek（或任意 Anthropic 兼容端点）上——见 `src/config/anthropicEnvMapping.ts`。
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
