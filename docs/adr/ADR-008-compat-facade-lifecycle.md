# ADR-008：Compat Façade 与版本生命周期

- 状态：Accepted（1.0 contract；工作树版本不等同于已发布 npm release）
- 日期：2026-07-11
- 决策范围：package root、`actoviq-agent-sdk/compat`、migration telemetry
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

Package root 当前暴露大量平台内部 symbol，真实用户可能依赖 `createAgentSdk`、`ActoviqAgentClient`、旧 ModelApi/session/event/team/workflow/Bridge 形状。一次性切换到 core/runtime/provider v2 会造成高风险破坏，但如果继续向 root 添加新 symbol，又无法冻结 1.0 contract。

需要一条可观测、可回滚、至少跨一个稳定 major 的迁移路径。

## 决定

### 1. 新 API 只进入职责 subpath

- `/core`：provider-neutral contract；
- `/runtime`：AgentRuntime、services、middleware、tools/state；
- `/providers`：provider registry/adapters；
- `/events`、`/surfaces`、`/orchestration`、`/workflow`、`/profiles`；
- `/node`：Node/SQLite adapter；
- `/compat`：旧 root surface 与迁移 adapter/diagnostic。

Root 在兼容期冻结：只接受安全修复、类型修复和必要 deprecated 标记，不再新增新平台内部 symbol。

### 2. 生命周期

| 版本阶段 | 新 subpath | Root façade | 允许的破坏 |
|---|---|---|---|
| 0.4.x hardening | internal/experimental | 默认可用 | 不引入大 surface；hotfix only |
| 0.5.x | 旧 surface freeze | 默认可用 | 仅 0.x 明示变更且提供迁移说明 |
| 0.6.x preview | 公开 preview | 默认可用 | preview contract 可修订，须 changelog/adapter |
| 1.x | core/runtime contract stable | deprecated 但支持 | 无 breaking；至少一个稳定 major 兼容窗 |
| 2.0+ | 依据真实迁移数据决定 | 才可考虑移除 | major only，提前公告与 codemod/adapter |

当前 `package.json` 是 `1.0.0`，表示本工作树的发布候选 contract；是否已经发布、远端 CI 是否全绿仍需外部 release/CI 证据，不能仅由版本字段推断。

### 3. Compat telemetry 本地、可关闭、无网络

`configureCompatDiagnostics()` 控制 process-local 计数、warn-once 和 callback；`getCompatDiagnostics()` 返回聚合。默认不持久化、不上传。当前只有 `createAgentSdk` 调用 `recordCompatUsage()`；其他旧 symbol 尚未覆盖，不能用现有计数推断全部迁移率。

### 4. Adapter 逐层过渡

已经实现并公开：

- `LegacyModelApiProvider`：旧 ModelApi → 新 ModelProvider；
- `ModelProviderLegacyAdapter`：新 ModelProvider → 旧 ModelApi。
- `LegacyAgentEventRunEventAdapter` / `RunEventLegacyCompatAdapter` / `LegacySurfaceEventPipeline`：旧新事件双向与产品 surface 迁移；
- `AgentRuntimeBridgeAdapter`：现有 `AgentRuntime` → native Bridge semantic stream。

当前没有独立公开实现的名称仍包括 `LegacyMessageAdapter`、`LegacyAgentClientFacade`、`LegacySessionAdapter`。迁移文档不得提供不存在的 import；旧 message/session/client 通过明确的 compat 路径和迁移步骤保留，不伪装成透明 adapter。

### 5. 删除条件

移除 compat façade 前必须同时具备：

- 至少一个稳定 major 的 deprecation window；
- 发布说明、old→new 示例和可运行 migration suite；
- 兼容统计覆盖主要入口且有真实采用数据；
- session/event/provider 的数据迁移与 rollback；
- 公开 API diff gate 确认只在 major 删除；
- TUI/GUI/Bridge 不再依赖被删除的内部路径。

## 拒绝的方案

### 1.0 直接删除旧 root

拒绝。没有真实迁移数据和完整 adapter 证据。

### 永久维护两套独立 SDK

拒绝。Compat 必须最终委托共同 contract/runtime，而不是继续演化第二套 engine。

### 自动上传兼容遥测

拒绝。会引入隐私、网络和 consent 问题；当前只提供本地 callback，由 host 决定是否聚合。

### 在 root 同时导出全部新 API

拒绝。会继续扩大冻结面并引入命名冲突。

### 仅用 TypeScript deprecated 注释完成迁移

拒绝。需要 runtime diagnostic、文档、adapter、测试和版本窗口共同支撑。

## 兼容影响

- `actoviq-agent-sdk/compat` 重导出 root，方便调用方显式声明依赖旧 surface；这不会自动改变运行语义。
- 开启 `warnOnce` 可能产生 process warning；默认当前为 false。
- Subpath output/result/event/session 形状不同，迁移需要编译期和行为测试。
- 历史 0.x preview 用户必须阅读 changelog；1.x 遵守 semantic version policy。

## Runtime 成本

- Compat diagnostic 是 process-local map，每个被记录 symbol 一条聚合记录；无网络/I/O。
- 双向 provider adapter 增加 canonical↔legacy 对象转换与可能的 raw/stream 映射成本。
- 同时打包 root 与 subpath 增加 dist/API review 面，但避免运行时双服务实例是首要约束。
- warn-once 使用 Node warning channel，host 可关闭或使用 callback。

## 测试证据

- [`tests/compat-diagnostics.spec.ts`](../../tests/compat-diagnostics.spec.ts)：本地计数、callback、禁用开关。
- [`tests/compat-provider-runtime.spec.ts`](../../tests/compat-provider-runtime.spec.ts)：新 provider 通过 adapter 驱动旧 `createAgentSdk`，输出保持旧形状。
- [`tests/provider-v2-legacy.spec.ts`](../../tests/provider-v2-legacy.spec.ts)：双向 provider adapter。
- [`tests/surface-run-events.spec.ts`](../../tests/surface-run-events.spec.ts) 与 [`tests/runtime-bridge-adapter.spec.ts`](../../tests/runtime-bridge-adapter.spec.ts)：事件/Bridge adapter。
- [`etc/public-api.json`](../../etc/public-api.json) 与 `scripts/public-api.mjs`：公开 API snapshot/diff gate。
- [迁移指南](../zh/09-sdk-v2-migration-guide.md)：仓库旧 TypeScript 示例到 1.0/compat 的完整映射矩阵。
- 既有 root compatibility suite 覆盖旧行为。

仍缺的 2.0 删除证据：主要旧 symbol 的全量 diagnostic、真实发布后的采用/弃用数据，以及依赖外部凭据或服务的旧示例在 release 环境中的矩阵结果。1.0 已具备 API diff gate、离线迁移矩阵和 adapter 测试，但这些不能替代真实迁移数据；因此不得宣称 2.0 可以删除 façade。

## 回滚方式

1. 新 subpath rollout 可由 host feature flag 切回 `/compat`/root。
2. Provider 层可单独通过双向 adapter 回滚，不要求同步回滚 runtime。
3. 关闭 compat warning/telemetry 不影响执行：`configureCompatDiagnostics({ enabled: false })`。
4. 版本回滚必须保留新 state/event 的 reader；如果旧版本读不了，先停止 writer 并恢复迁移前数据备份。
5. 不在 patch/minor 删除 compat symbol；误删应立即恢复并发布 patch。

## 参考

- [迁移指南](../zh/09-sdk-v2-migration-guide.md)
- [支持、安全、SemVer 与故障模型](../zh/10-support-security-semver-and-failure-model.md)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
