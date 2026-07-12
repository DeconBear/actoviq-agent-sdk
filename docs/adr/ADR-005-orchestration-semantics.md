# ADR-005：Manager-as-Tool、Handoff、Spawn 与 Workflow 语义

- 状态：Accepted（1.0 orchestration contract）
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/orchestration`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

Team、Swarm、Router、Reviewer 和 Workflow 如果各自实现 provider、session、retry、permission 和 child lifecycle，会产生第二套甚至多套 runtime。更重要的是，“manager 调用专家”和“把会话交给专家”有不同 conversation ownership；把二者都叫 delegation 会使历史、UI、权限和恢复语义含混。

## 决定

### 1. 四个 primitive 具有不同语义

| Primitive | Conversation owner | Session mode | 返回给父级 | 持久性 |
|---|---|---|---|---|
| Agent-as-tool | manager 保持 owner | child session | 一个 `tool_result` / child outcome | 当前调用内；可由 child store 扩展 |
| Handoff | target 成为 owner | transfer/current conversation | target items 或 handoff error | 随 conversation/run state |
| Spawn/background | parent 与 child 独立 | child | durable handle/status/result | `DurableChildStore` |
| WorkflowGraph | graph 不取得对话 owner；node 各自执行 | 由 node/ChildRunner 决定 | 有序 node outputs + reducer | graph 本身当前为内存执行，node 可持久化 |

### 2. ChildRunner 是唯一 child execution port

Agent tool、handoff、background 和 agent workflow node 都通过 `ChildRunner`/`OrchestrationRuntime` 调用同一 `AgentRuntime`。它们不得创建完整 SDK client。

### 3. Child scope 继承而不放宽

每个 child 继承：trace/parent span、abort/deadline、security policy、tenant/session namespace、workspace policy、shared budget、shared concurrency controller 和 `RuntimeServices`。Child 可以更严格，不能延长 deadline、扩大 workspace 或放宽 permission。

### 4. Failure policy 是显式数据

- `fail-fast`：失败抛出并取消组合路径；
- `collect`：失败变成 `ChildRunFailure` 数据；
- `retry-safe`：只允许 read 或带 idempotency key 的 idempotent-write；side-effect 禁止重放。

默认 agent-as-tool/handoff 以 `collect` 保存 ownership 语义；具体 preset 可显式选择更严格策略。

### 5. WorkflowGraph 是确定性 DAG

Graph 在构造时拒绝 duplicate/cycle/invalid reducer，按 lexical topological order 调度；支持 `all` barrier、`any` route join、条件 edge、bounded concurrency 和 reducer。Team/panel/reviewer/router/swarm 是这些 primitive 的 preset，而非新 engine。

### 6. Background child 是 durable state machine

`BackgroundChildManager` 把 queued/running/completed/failed/cancelled 与 revision 存入 `DurableChildStore`。进程重启后，只自动重放 read 或带 key 的 idempotent-write；可能已经发生的 side effect 要求人工 reconciliation。

## 拒绝的方案

### 所有多 agent 都使用 handoff

拒绝。Manager-as-tool 必须保持 manager 的 conversation ownership，不能把专家内部 transcript 注入主会话。

### 所有多 agent 都使用 tool call

拒绝。真正 handoff 需要 target 接管完整 canonical conversation，不能伪装成一个 tool result。

### Team 成员各自 createAgentSdk

拒绝。会线性增加 provider/MCP/session services，并使 policy/cancel/trace 不一致。

### 对整个 child run 无条件 retry

拒绝。run 内可能已经执行 side effect；只有 effect/idempotency contract 证明安全时才允许重放。

### 用 prompt 约定 graph 顺序

拒绝。确定性依赖、branch、join、reducer 和 budget 必须由代码 contract 表达。

## 兼容影响

- 旧 `ModelTeam`、`ActoviqSwarmApi`、router 和 `WorkflowEngine` 暂时保留；迁移后它们应逐步成为 preset/adapter。
- 新 primitive 的 result、event 和 conversation ownership 与旧 team result 不同，不能只按 text 比较；需要验证 owner、trace、usage 和 child status。
- `WorkflowGraph` 当前不是 durable graph scheduler；需要跨进程恢复的工作应使用 durable child/checkpoint，不能宣称 graph 自身已支持全图恢复。
- Handoff 由 orchestration API 显式触发；`executeHandoff()` 会调用 `AgentRuntime.beforeHandoff()`，再启动 target child 并转移 owner。core model loop 不自动消费 `handoff_call`，这是避免隐式 ownership 变化和 same-session 递归锁的 1.0 边界，不是未实现的 tool 旁路。

## Runtime 成本

- 每个 child 创建 run state/trace span，但共享 service/connection。
- Shared budget/concurrency 增加原子式计数与 semaphore 排队；防止 fanout 失控。
- Graph 保存 status/output map，内存与 node 数和结果大小相关；大结果应转 artifact reference。
- Durable background 每次状态迁移需要 store CAS；恢复需要读取/校验 record。
- Parent cancel 遍历 run tree；完成后 controller 会 prune 已终止节点。

## 测试证据

- [`tests/orchestration-v2.spec.ts`](../../tests/orchestration-v2.spec.ts)：agent-as-tool 与 handoff ownership 差异、scope inheritance、shared service、budget/concurrency、parent cancel、failure policies、graph/preset、durable background recovery。
- [`tests/profiles-v2.spec.ts`](../../tests/profiles-v2.spec.ts)：workflow/supervisor/background profile 选择对应 orchestration dependency。
- [`tests/model-team.spec.ts`](../../tests/model-team.spec.ts) 与 [`tests/team-runtime.spec.ts`](../../tests/team-runtime.spec.ts)：旧 team 兼容行为及 runtime-owned pool。

发布门禁已由端到端测试关闭：同一测试文件验证 10-member team 只初始化一组服务和完整 scope 继承；[`tests/surface-run-events.spec.ts`](../../tests/surface-run-events.spec.ts) 验证 TUI/GUI/Bridge 共享 parent/child 事件语义；[`tests/agent-runtime-v2.spec.ts`](../../tests/agent-runtime-v2.spec.ts) 验证 runtime `beforeHandoff` stage 在显式 transfer 路径生效。

## 回滚方式

1. 1.x 兼容窗口内可按功能把 preset 路由切回旧 ModelTeam/Swarm/WorkflowEngine；保留同一 security policy 和 deadline 配置。
2. 回滚前等待或取消 child tree；durable child record 不得丢弃。
3. 对状态为 running/unknown 的 side-effect child，先 reconciliation，再决定重试或标记失败。
4. 已转移 ownership 的 handoff 不能简单改写成 manager tool result；需从 handoff 前 checkpoint 恢复。
5. Graph 回滚应从最后成功 checkpoint/节点输出恢复，不能盲目重跑 side-effect node。

## 参考

- [OpenAI Agents SDK：Multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [OpenAI Agents SDK：Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\crewAI`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents`
