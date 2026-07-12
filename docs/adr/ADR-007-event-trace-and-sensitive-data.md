# ADR-007：Event / Trace Schema 与敏感数据

- 状态：Accepted（RunEvent schemaVersion 1 stable）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/events`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧 `AgentEvent` 是大型特例联合，TUI、GUI、Bridge 和 team 又各自增加事件形状。缺少统一 schema version、event identity、per-run sequence 和 parent/child trace 时，消费者无法可靠去重、排序和还原 run tree。与此同时，provider response、tool input/output、MCP header 和 metadata 可能携带 secret，trace sink 是新的数据外流边界。

## 决定

### 1. RunEvent 使用稳定 envelope

每个事件至少包含：

```text
schemaVersion, eventId, sequence, runId, parentRunId?,
traceId, spanId, parentSpanId?, type, timestamp, data
```

`type` 与 `data` 表达业务 payload；envelope 字段不能藏入 data。`schemaVersion: 1` 是 event reader 的兼容入口。

### 2. Sequence 只承诺 per-run 单调

`RunEventSequencer` 每个 run 从已提交 sequence 继续递增。全系统、跨 run 不承诺全局顺序。消费者以 `eventId` 去重，以 `(runId, sequence)` 检查顺序，以 trace/parent 还原树。

### 3. Parent/child 共用 traceId

Root run 创建新的 trace/span；child 继承 traceId，创建新 spanId，并把 parent span/run 写入 envelope。Handoff、agent tool、spawn 和 workflow child 都遵循相同关系。

### 4. Event pipeline 是 awaited boundary

Processor 顺序执行，可变换或丢弃事件；sink 顺序写入。默认 failure mode 为 `throw`，让审计/持久化失败对 run 可见；非关键遥测可显式使用 `isolate` 并配置错误回调。慢 sink 会施加 backpressure。

### 5. Redaction 在 sink 前且默认启用

`AgentRuntime` 把 `SensitiveDataRedactionProcessor` 放在用户 processor/sink 前，按敏感 key 递归替换 authorization、token、key、secret、password、cookie 等字段。MCP header/env 的明文不得进入 event/state/connection diagnostic。

Key-based redaction 不是内容检测：secret 如果放在普通字段或自由文本中仍可能泄漏。Host 必须避免记录 raw prompt/response，或增加自定义 processor、allowlist 和 sink retention policy。

### 6. OpenTelemetry 是兼容 adapter，不是强依赖

`OpenTelemetryRunEventSink` 生成 dependency-free readable span DTO，交给 caller 提供的 exporter。每 run buffer 有上限，超额丢弃最旧 span event并记录 dropped count；terminal event 触发 export，close 会输出 incomplete span。

## 拒绝的方案

### 继续让每个 UI 定义事件语义

拒绝。会导致同一 run 在 GUI/TUI/Bridge 中不可比较。

### 只依赖 timestamp 排序

拒绝。时钟精度、并发和跨进程 clock skew 无法保证顺序。

### 把完整 provider request/response 默认写入 trace

拒绝。数据体积和 secret/PII 风险不可接受；raw response 必须显式 opt-in。

### 强绑定某个 OpenTelemetry backend/SDK

拒绝。Core event contract 保持后台中立，exporter 由 host 提供。

### 遥测失败永远吞掉

拒绝。审计型 sink 失败必须可选择 fail closed；只有明确非关键 sink 才 isolate。

## 兼容影响

- 新 runtime stream 产出 `RunEvent`；旧 `ActoviqAgentClient.stream()` 仍产出 `AgentEvent`。
- CLI/TUI/GUI/legacy Bridge 仍可接收旧 `AgentEvent`，但都通过公开的 `LegacySurfaceEventPipeline` 执行 `AgentEvent → RunEvent → shared semantics`；native Bridge 使用 `AgentRuntimeBridgeAdapter` 直接消费新 runtime stream。该迁移统一的是事件语义和 redaction/trace/sequence 边界，不声称旧产品执行引擎已全部替换。
- 消费者必须忽略未知 additive data 字段；未知 schemaVersion 应停止或进入明确兼容路径。
- Sink 看到的是 redacted clone，不能依赖 secret 原值。

## Runtime 成本

- 每个 event 生成 UUID、timestamp 和 sequence；redaction 会递归 clone data。
- Awaited sink 增加 run latency，慢 sink 必须用 bounded queue/独立可靠 transport adapter，而不能无限缓存。
- OpenTelemetry sink 每个 active run 最多缓存 `maxBufferedEventsPerRun`，但 `seenEvents` 的长期 retention 仍需 host/后续实现评估。
- 详细 tool/model data 会增加序列化和存储；默认 event 应保持摘要化。

## 测试证据

- [`tests/run-events.spec.ts`](../../tests/run-events.spec.ts)：schema、per-run monotonic sequence、eventId dedup、parent/child trace、processor/sink 顺序和 failure mode。
- [`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts)：runtime lifecycle 通过 RunEvent 发出。
- [`tests/orchestration-v2.spec.ts`](../../tests/orchestration-v2.spec.ts)：child trace inheritance。
- [`tests/surface-run-events.spec.ts`](../../tests/surface-run-events.spec.ts) 与 [`tests/surface-product-wiring.spec.ts`](../../tests/surface-product-wiring.spec.ts)：同一 RunEvent 语义投影到 CLI/TUI/GUI/Bridge，并静态守卫真实产品接线。
- [`tests/runtime-bridge-adapter.spec.ts`](../../tests/runtime-bridge-adapter.spec.ts)：native runtime Bridge 不新建或关闭 runtime/services。

1.0 门禁已关闭：测试覆盖 key-based redaction 的普通文本非目标边界、slow sink awaited backpressure、failure isolation，以及 TUI/GUI/Bridge 同 run 的统一 acceptance。普通文本中的 secret 仍必须由 host allowlist/content processor/retention policy 处理，SDK 不宣称默认内容扫描。

## 回滚方式

1. Event sink 可逐个关闭；保留至少一个必要审计/诊断路径。
2. 非关键 exporter 故障可切换为 `isolate`，但必须保留 onError 指标；安全审计 sink 不得静默降级。
3. Surface 迁移期间可用显式 adapter 消费旧/新事件；禁止把 unknown event 当 text。
4. Schema v2 rollout 必须先提供 dual reader，再切 writer；回滚 writer 时继续读取已存在 v2 或恢复备份。
5. 发现 secret 泄漏时，立即停 sink/export、轮换凭据、清理下游 retention，并补充 redaction rule；不要只删除本地 event。

## 参考

- [OpenAI Agents SDK：Tracing](https://openai.github.io/openai-agents-python/tracing/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
