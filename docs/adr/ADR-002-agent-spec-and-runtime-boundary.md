# ADR-002：AgentSpec / AgentRuntime 边界

- 状态：Accepted（1.0 stable contract）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/core`、`actoviq-agent-sdk/runtime`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧 `ActoviqAgentClient` 同时拥有配置解析、provider、MCP、session、memory、skills、buddy、dream、team、GUI 适配和 conversation loop。构造一个最小 text agent 也可能触达与任务无关的目录和服务，难以形成可复用的 agent 定义、可测试的 runtime 状态机和受控的资源生命周期。

参考实现把“agent 的声明”与“runner 的执行”区分开。Actoviq 也需要让 chat、coding、research、workflow、supervisor 和 background profile 共享同一执行内核，而不是每种产品形态各建一套 SDK。

## 决定

### 1. AgentSpec 是不可变声明

`AgentSpec<TContext, TOutput>` 只描述：身份、instructions、model reference、tool/handoff/middleware reference、输入/输出 guardrail、output schema、limits 和 JSON metadata。

它不拥有 provider client、session store、timer、child process、MCP connection 或可变 conversation state。动态 instructions 可以读取 `RunContext`，但不得把 live dependency 塞入可持久化 metadata。

### 2. AgentRuntime 是执行与资源所有者

`AgentRuntime` 负责：

- 解析 provider/model 并运行有限状态机；
- 持有 `RuntimeServices`、`ToolRegistry`、middleware pipeline 和 event dispatcher；
- 应用 run/model/tool deadline、abort、usage budget 和 same-session serialization；
- 保存/恢复 `SerializedRunState`；
- 创建 `RunResult` 或 `RunHandle`；
- 在 `close()` 时取消 active run 并关闭已初始化资源。

一个 runtime 可以注册多个 `AgentSpec`。团队成员和 child run 复用 runtime-scoped services，不能为每个成员调用旧 `createAgentSdk`。

### 3. Mutable state 是 run-local 且可序列化

run 的 transcript、generated items、turn、usage、deadline、pending tool、trace、tenant/session/workspace identity 存在 `SerializedRunState`。状态中不保存 model client、函数、secret 或 signal。恢复时必须用已注册且 digest 一致的 agent spec。

### 4. 可选能力由 RuntimeServices lazy resolve

Runtime 构造不执行 service factory。只有 profile/middleware 或带 `sessionId` 的运行显式需要时才 resolve 对应 service。最小 chat agent 不应触发 session、memory、skills、agent directory、timer 或 subprocess。

### 5. Profiles 是组合，不是新 runtime

六类 profile 通过 `buildProfile()` 生成 `AgentSpec`、依赖清单和安全/工作区预期；`runProfile()` 先验证所需 service/middleware/tool，再调用同一个 `AgentRuntime.run()`。

## 拒绝的方案

### 每个 agent 实例内嵌 client 和 store

拒绝。会让多 agent 团队线性增加连接、文件句柄和缓存，也无法统一 cancel、budget 与 trace。

### 继续扩展 ActoviqAgentClient

拒绝作为新架构方向。它继续作为 compat façade，但不再承载新 core contract。

### AgentSpec 保存任意可执行插件

拒绝。工具和 middleware 使用 registry reference；可执行对象由 runtime owner 注册，便于审计、测试和持久化。

### 全局 singleton runtime

拒绝。它会跨 tenant/test 泄漏状态，生命周期和 policy 也不可控。Runtime 必须由 host 显式拥有和关闭。

## 兼容影响

- 旧代码仍可调用 `createAgentSdk()`；当前它仍创建旧 `ActoviqAgentClient`，并非已经透明代理到 `AgentRuntime`。
- 新代码从 `actoviq-agent-sdk/runtime` 构造 `AgentRuntime`，从 `core` 定义 agent。
- 旧 `ActoviqAgentDefinition` 与新 `AgentSpec` 尚无公开的一键转换器；迁移时应显式重建 spec，并对 tools/permissions/session 行为做验收。
- `RunResult.output/items/usage` 与旧 `AgentRunResult.text/message/messages/requests/toolCalls` 形状不同，调用方需要显式映射。

## Runtime 成本

- 每个 runtime 持有 registry、pipeline、event dispatcher、active-run map 和 same-session coordinator；这些是 runtime-scoped 固定成本。
- 每个 run 创建 abort boundary、usage accumulator、event sequencer 和 JSON-safe state snapshot。
- checkpoint store 启用时，状态更新会产生持久化写入；不配置 checkpoint 时无该 I/O。
- lazy service 降低最小 agent cold start，但首次 resolve 某 service 会承担初始化延迟。

## 测试证据

- [`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts)：run/stream/cancel、状态机、structured output、usage 与最小 runtime 行为。
- [`tests/runtime-services-v2.spec.ts`](../../tests/runtime-services-v2.spec.ts)：构造零 I/O、并发初始化合并、失败重试和 reverse-order close。
- [`tests/runtime-session-v2.spec.ts`](../../tests/runtime-session-v2.spec.ts)：session service 的 lazy resolve、CAS 和 same-session serialization。
- [`tests/profiles-v2.spec.ts`](../../tests/profiles-v2.spec.ts)：六类 profile 通过一个 runtime/provider contract 运行，并在启动前验证缺失依赖。
- [`tests/compat-provider-runtime.spec.ts`](../../tests/compat-provider-runtime.spec.ts)：新 provider 通过 adapter 驱动旧 façade 的兼容路径。

`createAgentSdk` 仍是由旧 engine 支撑的稳定 compat façade，而不是透明代理到 `AgentRuntime`；这是 1.x 兼容边界，不再被误写为新 runtime 的实现完成条件。CLI/TUI/GUI/legacy Bridge 已通过 `LegacySurfaceEventPipeline` 统一投影为 `RunEvent` 语义，native Bridge 则由 `AgentRuntimeBridgeAdapter` 直接包装调用方拥有的 runtime。对应证据见 [`tests/surface-product-wiring.spec.ts`](../../tests/surface-product-wiring.spec.ts) 与 [`tests/runtime-bridge-adapter.spec.ts`](../../tests/runtime-bridge-adapter.spec.ts)。

## 回滚方式

1. 1.x 用户可将 import 从 subpath 切回 package root，并继续使用 `createAgentSdk`。
2. Provider 已迁移但 runtime 未迁移时，使用 `ModelProviderLegacyAdapter`。
3. 不删除旧 session 和旧 client 路径，直到兼容窗口和迁移遥测满足 ADR-008。
4. 若新 runtime 状态无法恢复，保留 checkpoint，回滚到迁移前版本；不要用旧 client 解释新 `SerializedRunState`。
5. Runtime owner 必须先停止新流量、取消/等待 active runs、关闭 runtime，再切换实现。

## 参考

- [OpenAI Agents SDK：Agent](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK：Running agents](https://openai.github.io/openai-agents-python/running_agents/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\crewAI`
