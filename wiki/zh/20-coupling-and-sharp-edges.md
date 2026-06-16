# 20 — 耦合与尖锐边缘

跨模块关注点、已知设计问题以及在重构时需要关注的领域。

## 耦合分析

### 紧耦合（风险）

| 位置 | 问题 | 风险级别 |
|---|---|---|
| `agentClient.ts:591-597` | 4 个共享 Map 无锁 | **高** — 异步交错可导致 TOCTOU |
| `agentClient.ts`（3820 行） | 上帝类，12 个 API 接口 | **高** — 难以隔离测试和重构 |
| `conversationEngine.ts` → `agentClient.ts` | ReAct 循环依赖客户端的压缩、权限、钩子 | **中** |
| `actoviqAgents.ts` → `agentClient.ts` | Task 工具回调闭包了客户端方法 | **中** |
| `actoviqCompact.ts` ↔ `conversationEngine.ts` | 压缩引用了引擎的 tool_use_id 配对逻辑 | **中** |

### 松耦合（良好模式）

| 位置 | 模式 | 收益 |
|---|---|---|
| `tool()` 工厂 | 纯对象 + `execute` 函数 | 工具可独立测试 |
| `resolveRuntimeConfig()` | 纯配置函数 | 确定性，可用模拟选项测试 |
| `SessionStore` | 接口后的存储 | 可替换为数据库 |
| `ModelApi` 接口 | Provider 无关 | 新增 provider 无需改动 ReAct 循环 |
| `AgentSessionBindings` | 回调注入 | 会话可用模拟 bindings 测试 |

## 已知尖锐边缘

### 1. 共享可变状态无锁
四个 Map 在并发子代理操作间共享，无同步机制。`cancel()` 已有过一次 TOCTOU 修复。

### 2. 上帝类反模式
`ActoviqAgentClient` 直接拥有所有职责。建议提取 `SubagentOrchestrator`、`ContextAugmentor`。

### 3. `tool_use_id` 配对不变量
`tool_use_id` 必须在 assistant 和 user 消息之间匹配。压缩可能意外分离这对。`extendPreserveToIncludeReferencedToolUses()` 防护。

### 4. DeepSeek `type: "custom"` 拒绝
发送前去除工具定义中的 `type` 字段。

### 5. `isGitWorkspaceDirty` 默认干净
超时或错误时返回 `false`——防止 worktree 泄漏，但可能静默丢弃更改。

### 6. Windows 路径处理
`robustJsonParse()` 处理未转义的 Windows 路径。

### 7. `close()` 错误聚合
清理步骤独立运行，错误收集为 `AggregateError`。

### 8. 不稳定测试
`tests/actoviq-dream.spec.ts` 有不稳定测试（ENOENT on project-memory.md）。

### 9. 管道错误静默丢弃项
Pipeline 阶段错误将该项丢弃为 null——需在结果中收集和报告错误。

### 10. 无瞬态错误重试
ReAct 循环不重试瞬态 provider 错误。

## 架构决策记录（ADR）

- **ADR-1**：进程内 ReAct 循环 — 完全可调试性，无 IPC 开销
- **ADR-2**：JSON 文件存储 — 人类可读，可移植，崩溃安全
- **ADR-3**：Zod v4 用于工具 Schema — 类型安全运行时验证
- **ADR-4**：默认无限迭代 — Hadamard Harness 原则
- **ADR-5**：通过通知注入实现后台任务 — 模型被动接收结果
