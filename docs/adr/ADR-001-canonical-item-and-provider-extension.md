# ADR-001：Canonical Item 与 Provider Extension

- 状态：Accepted（1.0 stable contract）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/core`、`actoviq-agent-sdk/providers`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧运行时以 Anthropic 风格的 `MessageParam`、`Message`、`ContentBlock` 作为模型边界。它能支撑既有客户端，但会让会话、工具、Bridge 和其他 provider 依赖某一供应商的数据形状。结构化输出、图像、文档、reasoning、handoff 和未来 provider 私有 item 也没有稳定的共同表示。

通用 Agent SDK 需要同时满足：

1. runtime、session、event 和 orchestration 不导入 provider 类型；
2. 常用语义可跨 provider 保存、回放和测试；
3. 无法标准化的 provider 数据不能静默丢失；
4. 持久化状态必须是 JSON-safe，不保存 live client、`AbortSignal` 或 secret；
5. provider 能力必须显式声明并在请求前检查，不能根据 hostname 猜测。

当前实现位于 [`src/core/items.ts`](../../src/core/items.ts)、[`src/providers-v2/types.ts`](../../src/providers-v2/types.ts) 和三个 provider adapter 中。

## 决定

### 1. Canonical item 是 provider-neutral discriminated union

Core 以 `type` 为判别字段，现有稳定类别为：

- `text`、`image`、`audio`、`document`；
- `artifact_ref`；
- `tool_call`、`tool_result`；
- `handoff_call`、`handoff_result`；
- `reasoning`、`structured`、`refusal`、`error`；
- `raw`。

`InputItem` 可以包含完整 canonical transcript；`OutputItem` 约束模型或 runtime 可追加的 item。工具调用通过 `ToolCallItem.id` 与 `ToolResultItem.callId` 关联，不用数组位置关联。

### 2. 扩展数据只能走两个显式出口

- `ReasoningItem.opaque` 保存 provider reasoning 的不透明 JSON 值；core 不解释、不重建、不保证其可移植性。
- `RawItem { provider, value }` 保存没有 canonical 等价物的 provider item。

通用字段的扩展使用 JSON-safe `metadata`。禁止把任意 provider 字段直接摊平到所有 canonical item 上，也禁止在 `raw` 中放入 token、header 或其他 secret。

### 3. Provider adapter 对映射负责

OpenAI Responses、OpenAI Chat compatibility 和 Anthropic adapter 必须把 provider 请求/响应映射到 canonical item。默认保留未知 provider output item；完整原始响应只在 `includeRawResponse: true` 时保留，因为它可能扩大敏感数据和存储范围。

### 4. 能力在传输前预检

`ModelCapabilities` 明确列出输入模态、输出模态、tools、reasoning、streaming、prompt caching、stop sequences 和 raw round-trip。`ModelRegistry.prepare()`/adapter preparation 在 transport 调用前抛出 `CapabilityError`。能力可以由 adapter 默认值、模型表或调用方提供的 resolver 决定，但不能来自 URL/hostname 分支。

### 5. Schema 演进规则

- 1.x 期间允许补充可选字段或新增 item type，但不得改变既有 `type` 的语义。
- 删除/重命名 type 或把可选字段改为必填是 breaking change，只能进入 major release。
- 消费方必须对未知 `type` 采取“保留或显式拒绝”，不能静默当作 text。
- `schemaVersion` 属于包含 item 的持久化/event envelope；单个 item 暂不重复保存版本号。

## 拒绝的方案

### 直接采用 Anthropic 或 OpenAI 类型

拒绝。会把 runtime、session 和 orchestration 锁定到单一 provider，并迫使其他 adapter 伪造供应商字段。

### 所有内容统一为字符串

拒绝。工具关联、图像来源、结构化输出、reasoning opaque 和 artifact 引用会丢失类型与 round-trip 能力。

### 开放的 `{ type: string; [key: string]: unknown }`

拒绝。它无法提供可验证契约，持久化时也无法保证 JSON-safe。未知内容应显式进入 `RawItem`。

### Core 理解 provider reasoning

拒绝。reasoning 格式可能受供应商约束，且可能包含不可展示或不可重放的数据。Core 只保存 opaque 值与可选安全摘要。

## 兼容影响

- 旧 `ModelApi` 与 canonical item 的双向过渡由 `LegacyModelApiProvider` 和 `ModelProviderLegacyAdapter` 承担。
- 旧消息类型没有独立公开的 `LegacyMessageAdapter`；消息映射目前是 provider legacy adapter 的内部实现。迁移文档不得宣称该符号已发布。
- 部分新模态在旧消息模型中没有无损表达；迁移期间必须以 contract tests 覆盖的子集为准，未知 provider item 可能退化为 `raw` 或文本 JSON。
- Root API 继续保留旧类型；新代码应从 `actoviq-agent-sdk/core` 和 `actoviq-agent-sdk/providers` 导入。

## Runtime 成本

- 每次 provider 边界会创建小量映射对象，并对 JSON-safe 数据进行验证或 clone。
- `includeRawResponse` 和 `preserveProviderItems` 会增加内存、event 和 checkpoint 体积；默认不保留完整 raw response。
- capability preflight 增加一次 registry/capability lookup，但应在网络请求前失败，减少无效请求成本。
- Canonical transcript 使 session append 和 provider 重放需要序列化；大型二进制内容应使用 URL/file/artifact reference，不能内嵌无限 base64。

## 测试证据

当前证据：

- [`tests/core-contracts.spec.ts`](../../tests/core-contracts.spec.ts)：canonical item JSON round-trip、structured/image/reasoning/raw 等核心契约。
- [`tests/provider-v2-contract.spec.ts`](../../tests/provider-v2-contract.spec.ts)：同一 provider contract suite 覆盖 OpenAI Responses、OpenAI Chat 和 Anthropic adapter。
- [`tests/provider-v2-registry.spec.ts`](../../tests/provider-v2-registry.spec.ts)：capability preflight 与 registry 行为。
- [`tests/provider-v2-legacy.spec.ts`](../../tests/provider-v2-legacy.spec.ts)：旧/新 provider 边界转换。
- [`tests/core-usage.spec.ts`](../../tests/core-usage.spec.ts)：usage 的归一化与累计。

发布门禁：任何新增 canonical type 都必须增加 JSON round-trip、三类 adapter 映射或显式 unsupported、持久化 round-trip、redaction 检查。当前测试不能证明所有未来 provider 私有 item 均可跨 provider 无损移植。

## 回滚方式

1. 在 1.x 兼容窗口内，调用方可继续使用 root `MessageParam`/`Message` 和旧 `ModelApi`。
2. 新 provider 可用 `ModelProviderLegacyAdapter` 接入旧 `createAgentSdk`，无需立即迁移 runtime。
3. 若某 canonical 映射导致数据损失，adapter 可临时把该内容降级为 `RawItem`，而不是修改 core union 语义。
4. 已持久化的未知 item 必须保留；回滚代码若不能读取，应停止切换并使用迁移前备份，不能删除 item。
5. 1.x 不得通过 patch/minor 回滚既有 item 语义；必须增加兼容 reader 或留到 major version。

## 参考

- [OpenAI Agents SDK：Agents 与 output types](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK：Running agents / run items](https://openai.github.io/openai-agents-python/running_agents/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents`
