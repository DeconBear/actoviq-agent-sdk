# ADR-003：Middleware Stage 与不可移除 Invariant

- 状态：Accepted（1.0 invariant contract）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/runtime`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧 conversation loop 直接包含 prompt、memory、permissions、hooks、compaction、skills、loop detection 和产品特例。继续增加分支会让执行顺序不可见、扩展互相覆盖，也会使安全边界依赖调用者是否记得调用某个 helper。

新 runtime 需要可组合扩展点，同时必须保证取消、deadline、schema validation、permission、budget、checkpoint 与 event sequencing 不会被普通 middleware 移除。

## 决定

### 1. 生命周期采用固定 stage 表

公开顺序为：

1. `prepareInput`
2. `beforeRun`
3. `wrapModelCall`
4. `afterModelResponse`
5. `beforeToolCall`
6. `wrapToolCall`
7. `afterToolCall`
8. `beforeHandoff`
9. `afterTurn`
10. `finalizeOutput`
11. `afterRun`
12. `onError`

顺序由 `MIDDLEWARE_STAGE_ORDER` 明确给出，不依赖 enum 声明顺序。每个 stage 内 priority 越小越先执行并包裹后续 handler；同 stage 同 priority 在 build 时失败。pipeline 可 `inspect()` 和 `format()`。

### 2. Handler 使用 onion model

handler 接收 `(context, next)`。通用 pipeline 中不调用 `next()` 是显式 short-circuit；同一 handler 调用两次 `next()` 必须失败。`signal` 和绝对 `deadline` 原样传递，调用前检查 abort/deadline。未处理错误进入 `onError` stage。`AgentRuntime` 对 `wrapModelCall` 与 `wrapToolCall` 另外施加 reserved terminal-completion invariant：普通 middleware 必须调用并成功完成 `next()`，不能用通用 short-circuit 语义替换 provider/ToolRunner 安全边界。

### 3. 不可移除 invariant 不注册为普通 middleware

以下规则属于 runtime/tool/provider/storage 边界，普通业务 middleware 不能通过“未注册”来关闭：

- run/model/tool 的 deadline 与 parent abort；
- provider capability preflight；
- canonical/JSON/schema validation；
- `ToolRunner` 的 input/output validation 和 `ToolPolicy`；
- unknown tool 默认失败、未声明 tool effect 默认 `side-effect`；
- usage 累计和 budget 检查；
- same-session serialization 和 revision/CAS；
- checkpoint 中 pending side effect 状态；
- `RunEvent` sequence 与默认 sensitive-key redaction；
- child scope 不能放宽 parent deadline、policy、workspace 或 budget。

扩展可以补充更严格规则，不能放宽这些规则。

### 4. 当前实现的边界说明

`AgentRuntime` 记录 model/tool terminal 是否成功完成；未调用 `next()`，或在 provider/ToolRunner 失败后由 `onError` 伪造恢复结果，都会抛出 `MiddlewareInvariantViolationError`。所有 response middleware 完成后，model response 还要经过 canonical JSON、item type、finish reason 和 usage 后置校验。ToolRunner 只执行一次 output parser；其结果随后经过 JSON/artifact 形状校验、冻结，并要求 `wrapToolCall` 原样返回。因此 middleware 可以观测、计时和收紧结果，但不能移除或替换 capability、policy、schema 边界。

显式 `executeHandoff()` 在 input filter 之后、child run 与 ownership transfer 之前调用 `OrchestrationRuntime.beforeHandoff()`；`AgentRuntime` 的实现会执行 source agent 对应的 `beforeHandoff` pipeline。1.0 不自动消费模型返回的 `handoff_call`：handoff 是 host/orchestration 显式触发的 ownership transition，避免把它隐式降级为 tool call 或在同一 session lock 内递归运行。

## 拒绝的方案

### 一个通用 `onEvent` hook

拒绝。它无法表达 wrap/short-circuit，执行顺序和输入输出类型也不可验证。

### 用 import/注册顺序解决冲突

拒绝。不同 bundle 和动态加载会改变结果。priority 冲突应在 build 时失败。

### 把 permission、deadline 也做成可移除 middleware

拒绝。错误配置会直接关闭安全与资源边界。

### 继续在 conversationEngine 中硬编码 feature 分支

拒绝。新能力应进入独立 middleware/service；旧 engine 只做兼容维护。

## 兼容影响

- 旧 hooks 不会自动变成新 middleware；迁移需要为每个 hook 选择明确 stage，并验证 timeout 和错误语义。
- 新 pipeline 的同 priority 冲突会在构建时失败，旧系统中依赖隐式注册顺序的扩展必须分配唯一 priority。
- Middleware 可以改变 model response/final output，调用方必须更新 snapshot/contract tests。
- Root `ActoviqHooks` 继续存在于 compat API；新代码使用 runtime subpath 的 middleware contract。

## Runtime 成本

- 每个 stage 按 handler 数量增加 Promise/函数调用；空 stage 只有一次 terminal 调用。
- `inspect()` 在 build 时生成只读表，run 时不重复排序。
- awaited event/middleware 会把慢 handler 的延迟施加到 run；deadline 防止无限等待，但 handler 若忽略 signal，其后台工作仍可能继续。
- 过多细粒度 middleware 会增加 context clone/closure 成本，profile 应只注册必要能力。

## 测试证据

- [`tests/middleware-v2.spec.ts`](../../tests/middleware-v2.spec.ts)：固定 stage 顺序、priority 冲突、onion 顺序、short-circuit、double-next、deadline、abort、inspection。
- [`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts)：runtime 实际调用 model/tool/finalization stages。
- [`tests/runtime-tools-v2.spec.ts`](../../tests/runtime-tools-v2.spec.ts)：ToolRunner schema、policy、timeout、cancel 与 effect 默认值。
- [`tests/profiles-v2.spec.ts`](../../tests/profiles-v2.spec.ts)：profile middleware reference 在 run 前验证。

1.0 门禁已关闭：[`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts) 构造恶意 `wrapToolCall`/`wrapModelCall` short-circuit 并验证 fail-closed，同时以真实 `AgentRuntime + ChildRunner + executeHandoff` 证明 `beforeHandoff` 在 ownership transfer 路径执行。

## 回滚方式

1. 可按 agent 移除新增 handler，恢复空 pipeline；不可关闭 runtime invariant。
2. 若 priority 调整引起行为变化，使用 `inspect()/format()` 保存前后顺序并恢复上一份 registry 配置。
3. 旧 hook 用户可在兼容窗口内回到 root façade；不要把新 checkpoint 交给旧 loop 恢复。
4. 发生安全绕过时，优先禁用相关 extension/short-circuit，而不是关闭 ToolPolicy 或 validation。
5. 1.0 后修改 stage 顺序属于 breaking change；回滚必须恢复整个顺序表和相应 contract tests。

## 参考

- [OpenAI Agents SDK：Lifecycle hooks](https://openai.github.io/openai-agents-python/agents/#lifecycle-events-hooks)
- [OpenAI Agents SDK：Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
