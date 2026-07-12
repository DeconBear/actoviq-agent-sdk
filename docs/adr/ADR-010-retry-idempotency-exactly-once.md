# ADR-010：Retry、Idempotency 与 Exactly-once 承诺边界

- 状态：Accepted
- 日期：2026-07-11
- 决策范围：provider transport、tool/MCP、checkpoint、child/background
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

网络断开、进程崩溃和 timeout 会产生经典的不确定区间：调用方没有收到成功，不代表远端没有执行。对 model inference 重试通常影响成本；对文件写入、付款、消息发送、MCP tool 或 child run 重放则可能造成真实重复副作用。

Session CAS 和 checkpoint 可以记录本地状态，但无法与外部系统的 side effect 做分布式原子提交。因此 SDK 必须明确何时重试、何时禁止重放，以及不承诺 exactly-once 的边界。

## 决定

### 1. 不提供通用 exactly-once 承诺

Actoviq 只承诺：

- 本地状态转换使用 revision/CAS，避免静默覆盖；
- 已持久化为 `committed` 的 tool result 恢复时不重复追加；
- 明确标记为 side-effect 且处于 `started`/unknown 的操作不会被 runtime 自动重放；
- 只有调用方/目标系统提供稳定 idempotency key 并真正去重时，才能获得“effectively once”。

Checkpoint 与外部副作用之间不存在原子事务，不能宣称 exactly-once。

### 2. Tool effect 默认最保守

`ToolEffect` 为 `read | idempotent-write | side-effect`。未声明时默认 `side-effect`。`ToolRunner` 自身从不 retry；input/output validation、permission、deadline/cancel 在一次调用边界内执行。

Runtime 对 idempotent-write 生成稳定 `${runId}:${callId}` key，并传给 tool；tool/下游必须实际使用它才能安全去重。

### 3. Pending tool 状态先持久化再执行

状态为 `prepared → started → committed`，approval 使用 `awaiting_approval`。恢复规则：

- `committed + result`：补齐 transcript 后清理，不调用工具；
- `started + side-effect`：中断并要求人工 reconciliation；
- `awaiting_approval`：没有 decision 继续中断，reject 生成 error result，approve 才执行；
- read/idempotent 的具体重试仍需显式 orchestration policy，不能由崩溃恢复盲目触发。

### 4. Provider transport retry 有有限边界

`FetchProviderTransport` 默认最多两次 retry，响应 408/409/425/429/5xx 或可重试 transport error 时指数退避+jitter，并服从 Retry-After、signal 和 deadline。Streaming 只在建立响应前 retry；一旦 stream 产生事件，绝不重放该 stream。

Provider request 可能产生重复推理/计费，SDK 不把它等同于业务 side-effect exactly-once。

### 5. MCP tool call 不自动重放

MCP transport failure 会使 connection 失效，但当前 call 不 replay，因为 server 可能已完成副作用。下一次新逻辑调用可以重新连接，但必须是新的显式决策。

### 6. Child/background retry-safe 需要证明

`retry-safe` 只允许：

- `read`；
- `idempotent-write` 且非空 idempotency key。

`side-effect` 在 foreground ChildRunner 和 durable background 均拒绝 retry-safe。Stale durable execution 若可能已提交 side effect，则进入 reconciliation 而不是 replay。

### 7. 错误的 retryable 字段不是授权

Provider/tool error 的 `retryable` 仅为诊断分类。上层仍须结合 effect、commit state、attempt budget、deadline 和 idempotency contract 决定；不得看到 `retryable: true` 就重跑整个 agent run。

## 拒绝的方案

### 对整个 run 自动 retry

拒绝。Run 可能已经执行多个 side effect，无法安全回滚。

### 所有 tool 默认 read/idempotent

拒绝。漏标会导致危险重放；默认必须是 side-effect。

### transport failure 后自动重放 MCP call

拒绝。响应丢失与执行失败不可区分。

### 仅用 checkpoint 声称 exactly-once

拒绝。本地 checkpoint 与外部系统没有共同事务。

### 使用随机 idempotency key

拒绝。重试时 key 变化无法去重；key 必须由逻辑 operation identity 稳定派生。

## 兼容影响

- 旧 team `reconnectAttempts`/run-level retry 不再作为安全默认；provider transport retry 保留。
- 未声明 behavior 的新 runtime tool 会被视为 side-effect，可能比旧逻辑更保守。
- 旧工具若要使用 retry-safe，必须增加 effect 声明、稳定 idempotency key 和下游去重证据。
- 恢复时出现 reconciliation interruption 是正确行为，不应转换为自动成功/失败。

## Runtime 成本

- 每次 side-effect 前后的 checkpoint/CAS 增加持久化延迟。
- Idempotency ledger/下游去重需要额外存储，成本由 tool/provider owner 承担。
- Provider backoff 增加 tail latency，但受 deadline/maxRetries 限制。
- Manual reconciliation 增加运维成本，换取不重复执行未知 side effect。
- 禁止 run-level replay 可能降低瞬时成功率，但避免不可恢复的数据破坏。

## 测试证据

- [`tests/runtime-tools-v2.spec.ts`](../../tests/runtime-tools-v2.spec.ts)：ToolRunner 不 retry、effect 默认、policy、timeout/cancel。
- [`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts)：pending tool、approval、checkpoint/resume 和 committed result。
- [`tests/node-checkpoint-adapter.spec.ts`](../../tests/node-checkpoint-adapter.spec.ts)：pending side effect 持久化映射。
- [`tests/orchestration-v2.spec.ts`](../../tests/orchestration-v2.spec.ts)：retry-safe 限制、shared budget、durable stale recovery/reconciliation。
- [`tests/provider-v2-runtime.spec.ts`](../../tests/provider-v2-runtime.spec.ts)：provider retry/deadline/stream no-replay contract。
- [`tests/mcp-connection-manager.spec.ts`](../../tests/mcp-connection-manager.spec.ts)：tool transport failure 失效连接但不重放调用。

测试只能证明 SDK 不主动重复调用；真正 effectively-once 还必须由目标系统对 idempotency key 的持久化去重测试证明。

## 回滚方式

1. 调整 retry 参数可以降到 `maxRetries: 0`，不影响 provider adapter contract。
2. 发现重复 side effect 时立即禁用相关 retry-safe policy，将 effect 改为 side-effect，进入 reconciliation。
3. 不能通过删除 checkpoint“解决”unknown 状态；保留证据并查询目标系统。
4. Idempotency schema 变更需支持旧 key 的读/去重窗口，不能在 active operation 中途换 key 算法。
5. 旧 run-level retry 回滚只能用于经证明纯 read 的流程；不得全局恢复。

## 参考

- [OpenAI Agents SDK：Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [OpenAI Agents SDK：Running agents / resumable state](https://openai.github.io/openai-agents-python/running_agents/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
