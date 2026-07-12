# ADR-004：SessionStore / CheckpointStore / MemoryStore / ArtifactStore 分离

- 状态：Accepted（storage schema v1 / SDK 1.0 contract）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/node`、runtime durable state
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

会话历史、run checkpoint、长期记忆和大型 artifact 的生命周期、访问模式与安全属性不同。旧 JSON session 把 messages、runs 和部分 runtime metadata 放在一个文件中，完整重写会随历史增长，且无法精确表达 pending side effect、tenant namespace 或独立 artifact bytes。

同时，core/runtime 必须可在浏览器式或非 Node 环境导入，不能因为存储契约而立即加载 `node:sqlite`。

## 决定

### 1. 四个 store 是独立接口

- `SessionStoreV2`：tenant-scoped session metadata、append-only item journal、revision/CAS、snapshot compaction。
- `CheckpointStore`：run state、interruption、pending side effects、trace context 和独立 revision。
- `MemoryStore`：按 tenant/namespace 保存可修订 JSON memory。
- `ArtifactStore`：保存 bytes、media type、sha256 和 metadata；列表只返回 metadata。

`DurableStorageV2` 可组合提供四者，但调用方只依赖所需接口。Session 不是 checkpoint，memory 不是 transcript，artifact bytes 不进入 prompt/session JSON。

### 2. 所有 key 都带 tenantId

物理查询必须以 `(tenantId, resourceId)` 为主键。Runtime 适配器在没有 tenant 时使用显式 `default` namespace；多租户 host 不应依赖该默认值。

### 3. 写入采用 revision/CAS

Session append、snapshot compaction、checkpoint update、memory put 和 artifact put 都要求 expected revision。冲突必须抛出 `StorageConflictError`，不能 last-write-wins。

### 4. Session 使用 journal + snapshot

新增 item 只 append 新行并推进 sequence/revision。`compact()` 保存 throughSequence 对应 snapshot，后续 `load()` 从 snapshot 后读取增量。Snapshot 不删除审计 journal 的语义由具体 retention policy 决定；当前实现保留记录。

### 5. Node SQLite 是 adapter，不是 core 强依赖

`SqliteDriver` 是窄接口；`node:sqlite` 动态 import，仅在 `SqliteStorageV2.open()` 时加载。Runtime 通过 `SqliteRuntimeSessionAdapter` 和 `SqliteRunCheckpointAdapter` 使用 storage contract。

### 6. JSON v1 migration 是 copy/backup-first

Migrator 先解析与 dry-run，再把整个 source directory 复制到 source 外部并校验 hash，最后在一个 SQLite transaction 内写入所有 pending session 与 ledger。源文件不改名、不删除、不修改。相同 sourceId/sourceKey/hash 重跑为 `skipped`；内容变化则失败。

## 拒绝的方案

### 一个通用 KV store 接口

拒绝。无法表达 session append/CAS、artifact bytes、checkpoint side-effect 状态等不同 invariant。

### 每轮完整重写 session JSON

拒绝。写放大与历史长度线性增长，并发覆盖风险高。

### 将 checkpoint 存在 session metadata

拒绝。run pause/resume 和 session conversation 的 revision/lifecycle 不同，嵌套 child run 也需要独立 checkpoint。

### 直接在 core import node:sqlite

拒绝。会破坏可选依赖与最小 import，并把 Node 版本约束扩散到 provider-neutral contract。

### 迁移时就地修改旧文件

拒绝。失败后无法可靠回滚，也会破坏旧 façade 的继续运行能力。

## 兼容影响

- 旧 `SessionStore` 和 JSON v1 文件继续由 compat façade 使用；新 runtime 要显式注册 `sessions` service。
- 新 SQLite session item 是 canonical item；JSON v1 migrator 保留旧 message/run payload 及 legacy header，不会自动把所有旧 provider message 转成 canonical item。
- JSON v1 migration 与 runtime session adapter 是两个层次；完成 migration 不等于旧应用已经切换到新 runtime。
- 当前 storage API 没有“删除已迁移 session”的批量 rollback 方法；成功迁移后的业务回滚应切回旧 source，或恢复迁移前的整个 SQLite 数据库备份。

## Runtime 成本

- SQLite `DatabaseSync` 操作是同步 driver，运行在调用它的 Node 线程；高吞吐 host 应评估 worker/异步 driver adapter。
- CAS 增加一次 revision 校验，换取明确冲突语义。
- append 只写增量；load 成本取决于 snapshot 后 item 数量。
- artifact hash 计算与 byte copy 与 artifact 大小线性相关。
- 首次 `SqliteStorageV2.open()` 才加载 `node:sqlite` 和创建 schema；仅导入 contract 不产生 I/O。

## 测试证据

- [`tests/storage-v2.spec.ts`](../../tests/storage-v2.spec.ts)：四类 store、tenant isolation、CAS、append/snapshot、checkpoint side effects、artifact hash。
- [`tests/storage-v2-migration.spec.ts`](../../tests/storage-v2-migration.spec.ts)：dry-run 不导入 session/不创建 migration backup、backup-first、幂等重跑、冲突时整批 SQLite rollback、源文件保留。注意 storage open 本身会初始化目标 schema。
- [`tests/runtime-session-v2.spec.ts`](../../tests/runtime-session-v2.spec.ts)：runtime session adapter 与 same-session serialization。
- [`tests/node-checkpoint-adapter.spec.ts`](../../tests/node-checkpoint-adapter.spec.ts)：serialized run state 与 SQLite checkpoint 映射。
- [`tests/session-store.spec.ts`](../../tests/session-store.spec.ts)：旧 JSON store 的 schema/revision/CAS 兼容强化。

Phase 6 benchmark 门禁已通过：`npm run bench:runtime` 覆盖 10k/100k SQLite append/load/snapshot 场景；smoke 为 32 项 invariant，full 为 35 项。结果与复现命令见 [SDK 1.0 实施与验收报告](../zh/12-sdk-1.0-implementation-and-verification-report.md)。这些本机基线用于回归比较，不等同于所有部署存储介质的吞吐承诺。

## 回滚方式

1. 迁移前停止写入并备份旧 source 与目标 SQLite（包括 `-wal`/`-shm`，或在关闭连接后复制主库）。
2. dry-run 不写 source、不创建 migration backup、也不导入 session/item/ledger；`SqliteStorageV2.open()` 仍可能创建数据库并初始化 schema。要求目标完全零变更时应使用隔离临时 DB。
3. apply 失败时 SQLite transaction 自动回滚；保留错误、backup 和 source 供调查。
4. apply 成功但应用验证失败时，停止新写入并把读取/写入路由切回未修改的 JSON v1 source；不要把两边同时设为 writer。
5. 若必须恢复目标库，关闭所有 SQLite 连接后恢复迁移前整库备份；当前 API 不提供逐 session destructive rollback。
6. 详细操作见 [JSON → SQLite 迁移 Runbook](../zh/11-json-v1-to-sqlite-migration-runbook.md)。

## 参考

- [OpenAI Agents SDK：Sessions](https://openai.github.io/openai-agents-python/sessions/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
