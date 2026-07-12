# Actoviq Agent SDK 架构审计与 Runtime 优化规划

> 文档状态：设计规划 / 可执行草案
>
> 审计日期：2026-07-10（Asia/Shanghai）
>
> Actoviq 基线：package 0.4.6，commit df04baac2da7350b581231ef5540b456ffc1ed03
>
> 目标读者：SDK 维护者、runtime/agent/平台工程师、TUI/GUI/Bridge 维护者
>
> 结论性质：源码与文档静态审计；不是安全认证，也不替代真实负载压测
>
> 实施状态（2026-07-12）：Phase 0–6 已在当前工作树完成；历史基线与缺陷证据保留用于追溯。逐项实现、DoD 与 Node 22/24 端到端结果见 [12 SDK 1.0 实施与验收报告](./12-sdk-1.0-implementation-and-verification-report.md)。

## 1. 执行摘要

Actoviq 已经完成了一个相当丰富的 agent 平台原型：它不仅有基础 ReAct loop，还覆盖了工具权限、MCP、会话、压缩、记忆、Skills、子 agent、后台任务、worktree、workflow、swarm、model team、router、Bridge、TUI、GUI 和调度。就“能否构建 agent”而言，答案是肯定的；就“是否已经具备可复用、可扩展、可预测的通用 agent runtime”而言，答案是否定的。

当前实现最适合：

- 单机、单进程、可信用户环境；
- coding agent、research agent 和普通工具调用 agent；
- 中低并发、多 agent 实验、CLI/TUI/GUI 产品原型；
- 文件型会话、可接受 best-effort 恢复的本地任务。

当前实现不应直接用于：

- 多租户服务端和高并发共享 runtime；
- 要求 exactly-once 或严格幂等的业务 agent；
- 跨进程/跨机器的持久执行和长时间人工审批；
- 不可信 workflow 脚本；
- 真正的 handoff、可序列化暂停/恢复、完整 tracing；
- 对 OpenAI Responses、Anthropic 及其他 provider 高级能力要求等价的场景；
- realtime/voice 等低延迟专用 agent。

核心问题不是“功能少”，而是“过多功能直接耦合在同一个 client 和同一条运行路径中”。src/runtime/agentClient.ts 已达约 3996 行，src/types.ts 约 2904 行，根入口 src/index.ts 有 102 个 export 语句；createAgentSdk 同时装配会话、后台任务、mailbox、teammate、memory、dream、swarm、workflow、skills、agents 和 MCP。结果是：

1. 最小 agent 也承担平台级初始化与运行时语义；
2. 可选能力无法独立启停、替换和测试；
3. team/workflow/bridge 形成多套相似但不一致的执行模型；
4. provider、session、event、tool 和 orchestration 的边界不够稳定；
5. 正确性、资源上限、恢复语义和观测性不足以支撑生产级 runtime。

推荐路线不是重写，而是“先止血、再抽核心、最后迁移”：

1. 先修复会话并发、流式背压、超时/取消、MCP 生命周期、team 重试和 workflow 信任边界；
2. 新增 provider-neutral item、AgentSpec、RunContext、RunState、SessionStore、CheckpointStore、Middleware、EventSink 等小型核心契约；
3. 把 memory、skills、permissions、compaction、subagent、team、workflow 等改成 runtime 组合件；
4. 统一 manager-as-tool、handoff、code workflow 和 background spawn 四种编排语义；
5. 保留 createAgentSdk 兼容门面，逐步迁移 TUI/GUI/Bridge，避免大爆炸式改造。

## 2. 审计范围、方法与限制

### 2.1 审计范围

本次检查覆盖：

- 公共 API、类型和包入口；
- provider/model 抽象与 Anthropic/OpenAI 适配；
- agent loop、stream、tools、MCP、permissions、hooks；
- session、checkpoint、memory、compaction、background task；
- subagent、swarm、team、router、workflow；
- TUI/GUI/Bridge 对 runtime 的依赖方式；
- CI、测试结构、版本与文档承诺；
- 参考项目的公开文档和本地源码快照。

不在本次范围：

- 对每个 GUI handler 做逐行安全审计；
- 用真实 provider key 进行质量评测；
- Windows 安装包、Electron 渲染性能和 UI 视觉评审；
- 对第三方项目作完整功能评测。

### 2.2 证据基线

Actoviq 仓库事实：

- 145 个 TypeScript 源文件，约 64,852 行；
- runtime 约 11,753 行，provider 约 1,862 行，team 约 3,374 行；
- GUI 单文件约 17,777 行，TUI 主文件约 3,979 行；
- 78 个 Vitest spec 文件；
- CI 覆盖 Windows Node 22、Linux Node 20/22，但 package.json 仍声明 Node >=18；
- 本地工作树没有 node_modules，npm run typecheck 在启动时因找不到 tsc 而失败，因此本次没有把“未能运行测试”当作代码失败。

行号均对应上述 commit；后续修改后应以符号名为准。

### 2.3 优先级定义

- **P0**：可能导致数据丢失、资源失控、安全边界误判、重复副作用或不可恢复，阻止生产使用。
- **P1**：明显限制扩展、性能、可测试性、跨 provider 一致性或多 agent 规模。
- **P2**：维护性、文档、开发者体验和未来能力缺口。

## 3. 当前架构与已经做到的能力

### 3.1 当前主要数据流

~~~mermaid
flowchart LR
    API["createAgentSdk / ActoviqAgentClient"] --> CLIENT["God Client: sessions, agents, skills, tasks, memory, dream, swarm, workflow"]
    CLIENT --> ENGINE["executeConversation ReAct loop"]
    ENGINE --> MODEL["ModelApi"]
    MODEL --> ANTH["Anthropic Messages-style adapter"]
    MODEL --> OAI["OpenAI Chat Completions adapter"]
    ENGINE --> TOOLS["Local tools + permission checks"]
    ENGINE --> MCP["MCP connection manager"]
    ENGINE --> STORE["JSON SessionStore"]
    CLIENT --> ORCH["Task / Swarm / Team / Workflow / Router"]
    ORCH --> CHILD["新 session 或新 createAgentSdk 实例"]
    CLIENT --> SURFACE["TUI / GUI / Bridge / Scheduler"]
~~~

### 3.2 已实现能力清单

| 领域 | 当前已经做到什么 | 主要证据 | 成熟度判断 |
|---|---|---|---|
| 基础 agent loop | 支持多轮模型调用、tool call/result 回灌、流式和非流式执行、max-token 恢复、模型 fallback | src/runtime/conversationEngine.ts:99-898 | 功能完整，边界需重构 |
| 工具 | Zod 输入/输出校验、别名、只读/破坏性标记、权限、进度、并发安全、结果 artifact 化 | src/types.ts:178-247；src/runtime/tools.ts | 较成熟 |
| 并行工具 | 连续只读或 concurrency-safe 工具按上限并行，保留原始结果顺序 | src/runtime/conversationEngine.ts:768-804、1037-1088 | 可用 |
| 上下文控制 | 本地 microcompact、loop compact、reactive compact、Anthropic prompt cache、超大 tool result 落盘 | src/runtime/conversationEngine.ts:154-268、903-1024 | 功能丰富但耦合较深 |
| Provider | 自有 ModelApi，Anthropic 协议和 OpenAI Chat Completions 映射，允许注入自定义 modelApi | src/types.ts:281-304；src/provider/openai-model-api.ts | 基础可用，高级能力缺失 |
| MCP | local、stdio、streamable HTTP；工具名命名空间；连接复用 | src/types.ts:249-279；src/mcp/connectionManager.ts | 可用但生命周期有 P0 |
| 权限与 hooks | permission mode、rule、classifier、approver、canUseTool、session/post-sampling/post-run/stop hooks | src/types.ts:44-145、363-452 | 能力多，缺少统一 policy/middleware |
| Session | create/resume/fork、checkpoint、metadata、tags、compact、memory、stream | src/runtime/agentSession.ts | 单进程可用 |
| 崩溃恢复 | 每个 tool-result turn 后写会话 checkpoint，避免仅在整轮完成时持久化 | src/runtime/conversationEngine.ts:85-90、862-869 | best-effort |
| Memory | project/user/team/session memory、相关记忆、自动提取、dream、compact | src/memory；src/runtime/agentClient.ts:2194-2366、3418-3585 | 产品化能力强，默认路径太重 |
| 子 agent | Markdown agent definition、Task/Agent 工具、深度/fanout、background、SendMessage、worktree | src/runtime/actoviqAgents.ts；src/runtime/agentClient.ts | manager-as-tool 可用 |
| Swarm | teammate、mailbox、broadcast、background、恢复和 transcript | src/swarm/actoviqSwarm.ts | 实验性 |
| Model Team | panel/reviewer/graph、并发池、事件、成本估算、多 provider member | src/team | 实验性，runtime 重复 |
| Workflow | DAG builder/engine、script workflow、parallel/pipeline、resume state、budget | src/workflow | 功能丰富，持久与安全语义不足 |
| Router/Bridge | 跨模型路由、外部 runtime 进程桥接、兼容矩阵、会话 transcript | src/router；src/parity | 平台能力，不应污染最小 core |
| 产品表面 | CLI、TUI、Electron GUI、scheduler、manager、issue store | src/cli、src/tui、src/gui、src/scheduling | 产品层，应与 SDK core 分层 |
| 测试 | 78 个 spec，覆盖长运行、压缩、恢复、权限、team、workflow、bridge、GUI 安全 | tests | 数量可观，缺少关键 contract/fault tests |

### 3.3 重要正面结论

以下设计值得保留：

1. 工具 schema 与执行函数分离，输入/输出均可校验；
2. tool result artifact 和批量结果预算解决了长上下文真实问题；
3. 中途 checkpoint、reactive compact 和 dangling tool-result 配对意识较强；
4. worktree、background task、SendMessage 和 agent definition 对 coding agent 很实用；
5. provider 可注入 modelApi，为后续适配器重构留下了迁移口；
6. 已经有事件流、runId、parentRunId、sessionId 和 usage 等观测基础；
7. 有完整兼容测试与 Bridge parity 思路，适合充当迁移回归基线。

## 4. 多种 Agent 类型适配性评估

| Agent 类型 | 当前适配度 | 已有基础 | 主要缺口 | 规划结论 |
|---|---:|---|---|---|
| 普通对话/工具调用 agent | 4/5 | ReAct、tools、session、stream | structured output、guardrail、统一 context | 第一优先级，作为 core 基线 |
| Coding agent | 4/5 | 文件/shell/worktree、plan、todo、subagent、TUI/GUI | 真 sandbox、幂等重试、长任务恢复、并发会话锁 | 第一优先级，保留 Actoviq 差异化 |
| Research agent | 3.5/5 | Web tools、parallel、subagent、memory | 引用/artifact 一等类型、来源追踪、预算策略 | 第一优先级 profile |
| Manager/supervisor agent | 3.5/5 | Task/Agent、team、router、workflow | manager-as-tool 与 handoff 未区分；状态/事件分裂 | 第一优先级 orchestration |
| Deterministic workflow agent | 3/5 | DAG、script、parallel、pipeline | durable RunState、exactly-once、可信脚本边界 | 第二优先级 |
| Persistent/background agent | 2.5/5 | background store、reconcile、scheduler、mailbox | 跨进程租约、队列、CAS、durable interrupt | 第二优先级 |
| Multi-tenant service agent | 1.5/5 | session id、run id、权限 | 全局状态、文件存储、并发隔离、审计和配额 | 暂不宣称支持 |
| Human-in-the-loop agent | 2/5 | tool approver、AskUserQuestion | 进程退出后无法恢复审批；无序列化 interruption | 第二优先级 |
| Multimodal/computer-use agent | 2.5/5 | computer-use、部分 image content | canonical multimodal item、provider capability、artifact | 接口先行，逐步补齐 |
| Realtime/voice agent | 0.5/5 | 无专用 transport/runtime | 音频 item、低延迟 session、打断、VAD、实时 guardrail | 独立 runtime，非本轮核心目标 |

结论：Actoviq 可以成为“多类型 agent SDK”，但不能继续通过给 ActoviqAgentClient 增加方法来实现。不同 agent 应是同一个小 runtime 上的 profile/组合，而不是不同执行引擎。

## 5. 设计与逻辑缺陷

### 5.1 P0：必须优先处理

| ID | 问题与证据 | Runtime 影响 | 修复方向 |
|---|---|---|---|
| P0-01 | 同一 AgentSession 没有 per-session mutex；send/stream 都直接从当前 snapshot 启动。SessionStore.save 只是原子替换，不做 revision/CAS。证据：src/runtime/agentSession.ts:132-163；src/storage/sessionStore.ts:59-76 | 两个并发 turn 可能从同一旧快照运行，后保存者覆盖先保存者，造成消息、run summary、metadata 丢失 | 单进程 per-session 串行队列；持久层 revision + compare-and-swap；冲突时明确失败或重放，不能静默覆盖 |
| P0-02 | AsyncQueue 使用无上限 values 数组；AgentRunStream 构造后立即执行，即使无人消费也持续缓存事件；没有 iterator.return、容量、背压或 delta 合并。证据：src/runtime/asyncQueue.ts:5-69 | 长输出/高频 tool.progress/无人消费 stream 时内存线性增长，无法可靠取消 | run 与 stream 分离；stream 使用有界 channel；文本 delta 可合并，生命周期事件不可丢；RunHandle 提供 cancel/dispose |
| P0-03 | 默认 maxToolIterations 是 Infinity；普通工具没有统一 timeout；MCP call 忽略 ToolExecutionContext.signal；hooks 无统一 deadline。证据：src/config/resolveRuntimeConfig.ts:152-164；src/runtime/conversationEngine.ts:696-713；src/mcp/connectionManager.ts:151-166 | 模型循环、工具、MCP 或 hook 任一挂起都可长期占用进程、连接和并发槽 | 新 runtime 设有限默认 turn/deadline；模型、工具、MCP、hook 都从同一 Deadline/AbortSignal 派生；兼容层保留旧值但告警 |
| P0-04 | team member 最多把整个任务从头重试 10 次，每次重新 createAgentSdk；同时固定 bypassPermissions。证据：src/team/teamRuntime.ts:150-222 | 重复模型费用、重复副作用、重复目录扫描和存储初始化；team 绕过调用方安全策略 | provider request 级重试下沉；run 级重试仅允许无副作用或有 idempotency key 的任务；继承 policy，不得硬编码 bypass |
| P0-05 | WorkflowScriptRuntime 把 node:vm 称为 sandbox，并依赖 vm timeout；异步 IIFE 的后续 promise 工作不等价于完整资源隔离。证据：src/workflow/workflowScriptRuntime.ts:3-8、667-729 | 如果脚本来自不可信来源，会形成错误安全承诺；CPU、内存、异步任务和宿主能力难以可靠限制 | 把 in-process vm 明确标为 trusted-script；不可信脚本默认禁用，交给隔离进程/容器型 WorkflowExecutor；能力只经 RPC 暴露 |
| P0-06 | MCP 每次 run 对每个 server 串行 listTools；连接 key 忽略 stdio env/cwd 与 HTTP headers/sessionId；callTool 不传取消/超时。证据：src/mcp/connectionManager.ts:49-99、113-177、180-185 | 冷/热路径延迟、错误复用旧凭据或旧目录、挂起无法取消、配置更新不生效 | 完整配置指纹、tool catalog TTL/变更通知、并行发现、lease/refcount、deadline/reconnect、按 server 隔离 |
| P0-07 | StoredSession 虽有 version:1，但 load 直接 JSON.parse 后 cast；WorkflowResumeState 使用 Map/Set，不是 JSON-safe。证据：src/storage/sessionStore.ts:65-76；src/types.ts:1496-1518、2468-2475 | 损坏/旧 schema 可能在运行中才失败；workflow resume 不能直接跨进程持久化 | schema 校验、版本迁移、JSON-safe DTO；会话 history 与运行 checkpoint 分开版本化 |
| P0-08 | createActoviqTaskTool 内 fanoutByRun Map 只 set、不 delete；AgentPool 是进程全局 singleton。证据：src/runtime/actoviqAgents.ts:220、364-369；src/team/agentPool.ts | 长寿命 client 按 runId 泄漏；多个 SDK/租户互相争抢同一全局池，关闭一个 runtime 也难定义所有权 | fanout 计数归入 RunContext 并随 run 释放；ConcurrencyController 由 runtime 实例拥有，可显式共享 |
| P0-09 | session checkpoint 与最终持久化写入 __actoviqWorkDir 时使用 this.config.workDir，而不是当前解析出的 workDir。证据：src/runtime/agentClient.ts:2014-2019、2092-2105、3433-3437 | worktree/override run 的恢复目录可能退回主目录，后续工具运行在错误 workspace | workspace identity 成为 RunContext/SessionState 的强类型字段，禁止藏在 metadata magic key 中 |

Node.js 官方文档明确说明 node:vm 不是安全机制，不应用来运行不可信代码：
https://nodejs.org/api/vm.html

### 5.2 P1：架构与规模瓶颈

| ID | 问题与证据 | Runtime/设计影响 | 规划动作 |
|---|---|---|---|
| P1-01 | ActoviqAgentClient 同时拥有 sessions、agents、skills、tasks、buddy、memory、dream、swarm、context、workflow，约 3996 行。证据：src/runtime/agentClient.ts:579-745 | God object；任一能力修改都可能影响主 loop；测试替身和最小部署困难 | Client 只做 façade；Runtime 通过显式 services + middleware 组合 |
| P1-02 | create 会扫描 agents/skills、构造四种 store、memory/dream/swarm，并 reconcile background task；每次 session run 还进入 memory/compact/dream 路径。证据：src/runtime/agentClient.ts:801-867、2194-2215、3418-3585 | 冷启动、文件 I/O、后台任务和提示词体积不透明；不用的功能也参与运行 | 所有可选能力 lazy init；profile 显式开启；core runtime 不扫描用户目录 |
| P1-03 | ModelApi 和 canonical message 实际采用 Anthropic 风格字段，再把 OpenAI Chat Completions 双向转换。证据：src/provider/types.ts；src/provider/openai-model-api.ts:26-184 | Responses item、reasoning、hosted tools、multimodal、response id、provider extensions 容易丢失；适配器被迫伪装 | 新建 provider-neutral InputItem/OutputItem；provider adapter 保留 opaque raw item 与 capability |
| P1-04 | 是否启用 Anthropic context management 通过 baseURL host 判断。证据：src/runtime/conversationEngine.ts:201-231、1384-1391 | Anthropic-compatible proxy、私有部署或错误 URL 产生错误能力判断 | ModelCapabilities 显式声明；禁止按 hostname 推断协议能力 |
| P1-05 | 每个 tool batch checkpoint 和每次 run 都深拷贝、重写完整 session JSON。证据：src/runtime/conversationEngine.ts:862-869；src/runtime/agentClient.ts:2092-2105、3427-3541 | 长会话产生 O(history) 单次写入与近似 O(n²) 累计写放大；并发更难控制 | append-only journal + 周期 snapshot；本地 SQLite driver 作为推荐默认，JSON driver 仅兼容 |
| P1-06 | SessionManager 暴露 maxConcurrentActive，但明确 NOT YET ENFORCED。证据：src/types.ts:1549-1557 | API 看似提供限制，实际上不能保护 runtime | 要么实现全局 semaphore + per-session lock，要么在旧 API 中移除/报错，禁止静默无效配置 |
| P1-07 | Task、Swarm、Team、Workflow 各有自己的状态、结果、事件和重试语义；team 还为成员创建完整 SDK。 | 无法统一取消、预算、trace、HITL、恢复；同一 agent 在不同编排器表现不同 | 统一为四种 primitive：asTool、handoff、workflow、spawn；team/swarm 变成 preset |
| P1-08 | 当前 permission 是同步调用链中的 callback；没有可序列化 interruption/RunState。 | 审批必须保持进程和闭包存活，无法排队、跨服务恢复 | 引入 RunState、Interruption、Decision 和 resume；Session 不承担 run checkpoint 职责 |
| P1-09 | AgentEvent 是大 union，但没有 schemaVersion、eventId、sequence、traceId/spanId、producer namespace。证据：src/types.ts:1253-1481 | 事件难重放/去重；多 agent 树与 provider/tool latency 无统一 trace；UI 只能按特例解析 | 统一 RunEvent envelope + EventSink/TraceProcessor；保留 typed payload |
| P1-10 | AgentRunResult.usage 只取 finalMessage.usage，完整 usage 分散在 requests；StoredRunSummary 持久化该值。证据：src/runtime/conversationEngine.ts:555-571；src/runtime/agentClient.ts:3519-3528 | 多 iteration 成本和 token 统计可能低估 | UsageAccumulator 成为 RunContext 核心状态；结果同时给 total 与 per-call breakdown |
| P1-11 | AgentDefinition 没有通用 output schema、input/output/tool guardrail、handoff 和 typed context。证据：src/types.ts:455-483 | 业务 agent 需要在 prompt 或 workflow 特例中模拟结构化输出；不能表达真正 peer handoff | AgentSpec<TContext,TOutput> 一等支持 output、guardrails、handoffs、middleware |
| P1-12 | 根入口静态导出 102 组内容，types.ts 混合 core、buddy、scheduler、bridge、workflow、team。 | API 难冻结，加载与类型导航成本高，任何内部类型都容易变成兼容负担 | 稳定 root 只保留 façade；新增 core/runtime/orchestration/providers/compat subpath exports |
| P1-13 | 大量 best-effort catch 吞错，包括 checkpoint、session touch、cleanup、dream。 | 用户只看到最终异常或无异常，无法区分降级、数据未落盘、后台失败 | ErrorPolicy + diagnostic events；明确 fatal/retryable/degraded/ignored，所有忽略必须可观测 |

### 5.3 P2：维护与能力缺口

1. package.json 声明 Node >=18，但 2026-07 的 Node 18/20 已 EOL，CI 仍测 Node 20；应统一为 Node 22/24 LTS。官方状态：
   https://nodejs.org/en/about/previous-releases
2. package 为 0.4.6，源码和注释多处标为 v0.5.0，CHANGELOG 最新完整章节仍是 v0.4.0；版本事实不一致。
3. 中文 VitePress sidebar 已漏掉现有 07 workflow 文档，说明文档信息架构没有和功能演进同步。
4. Markdown agent frontmatter 是自制的平面解析器，复杂列表/嵌套/错误值会被静默简化；应采用明确 schema 和诊断。
5. 新公共类型仍出现 any，例如 WorkflowScriptContext；新核心契约应禁止默认 any。
6. CI 没有 coverage threshold、provider contract suite、并发/背压/故障注入、安全边界测试。
7. benchmark 偏任务质量，缺少 runtime cold start、event throughput、session write amplification、MCP warm cache、team resource usage。

## 6. 当前设计对 Runtime 的具体影响

| 阶段 | 当前行为 | 影响 | 优化目标 |
|---|---|---|---|
| 包加载 | 根入口静态关联大量平台模块 | 解析/初始化面大，边界模糊 | subpath exports；core 无 GUI/TUI/bridge/memory side effect |
| createAgentSdk | 解析配置、构造多个 store、扫描 agent/skill 目录、reconcile background tasks | 冷启动 I/O，最小 agent 不最小 | createRuntime 只装配显式 service；目录扫描由 profile/plugin 触发 |
| 每轮 system prompt | 读取 memory state、构造 memory/buddy/tool prompts | prompt 膨胀、文件 I/O 和隐藏行为 | PromptComposer middleware，显示 token/来源预算，可逐项禁用 |
| 每个 provider request | 深拷贝消息、估 token、JSON 计算 byte length、可能 compact | CPU/内存随 history 增长 | canonical immutable items、增量 token accounting、snapshot cache |
| 每个 MCP run | 串行 listTools | 网络/进程延迟乘 server 数 | catalog cache + revision/TTL + 并行发现 |
| 每个 tool call | permission 与执行耦合；无统一 deadline/idempotency | 卡死与重试副作用风险 | ToolExecutionPolicy；deadline、idempotency、retry、concurrency key |
| 每个 tool batch | 完整会话深拷贝与 JSON 覆写 | 长会话写放大；并发覆盖 | append journal + CAS + snapshot |
| stream | producer 主动运行，无限事件缓存 | 无消费者时内存增长 | lazy bounded stream；coalescing/backpressure/cancel |
| team member | 获取全局池，再创建完整 SDK，失败时从头重建 | 冷启动、重复扫描、重复费用、全局争用 | 共享 RuntimeServices；轻量 child RunContext；分层 retry |
| workflow script | 同进程 vm 执行，10 分钟参数被当作沙箱限制 | 不可信脚本风险；异步资源难约束 | trusted/untrusted 两级 executor |
| run 完成 | persist、transcript、memory extraction、compact、auto dream | 尾延迟与后台工作不透明 | afterRun middleware；任务队列、预算、明确一致性级别 |

## 7. 参考项目基线

所有本地参考源码均按 2026-07-10 检查，均为 MIT License。

| 参考项 | 上游/官方链接 | 本地路径或快照 | Commit / 版本 |
|---|---|---|---|
| OpenAI Agents SDK 官方文档 | https://openai.github.io/openai-agents-python/ | 在线文档，审计日访问 | 文档随上游更新 |
| CrewAI | https://github.com/crewAIInc/crewAI | E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\crewAI | 7baf8f9ba1a03e34ec360b38ae62ef33d245e708；crewai 1.15.2 |
| DeerFlow | https://github.com/bytedance/deer-flow | E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow | c0b917cce2cd8b8644a3ed17d58ddb31adc5299a；2.1.0 |
| DeepAgents | https://github.com/langchain-ai/deepagents | E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents | ddce7c3f524109b10ea13ef56afbd1ac99f9e300；deepagents 0.6.12 |
| OpenAI Agents Python 源码 | https://github.com/openai/openai-agents-python | E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python | 0354f482a8e76d33c50a6a3e462c814eefde1e6b；0.18.1 |

## 8. 参考项目：有什么、哪些适合、哪些不适合

### 8.1 OpenAI Agents SDK

**它有什么**

- 少量核心 primitive：Agent、Runner、Tools/Agents-as-tools、Handoffs、Guardrails；
- Agent 与 Runner 分开：Agent 描述能力，Runner 管理 turn/tool/session/handoff；
- typed context 和 structured output；
- manager-as-tool 与 handoff 两种清晰的多 agent 语义；
- Session protocol 与多种存储实现；
- 可序列化 RunState，用于 interruption、审批和跨进程恢复；
- input/output/tool guardrails；
- run/agent lifecycle hooks；
- 内建 trace/span 和可替换 tracing processor；
- provider abstraction、MCP、streaming、realtime/voice、sandbox agent。

本地源码证据：

- src/agents/agent.py:174、270、305、322-341、487、508；
- src/agents/run.py:198-445；
- src/agents/run_config.py:212-315；
- src/agents/run_state.py:188、660、1033；
- src/agents/memory/session.py:14-102；
- src/agents/tracing/provider.py:174-243。

**适合 Actoviq**

1. AgentSpec 与 Runner/Runtime 分离；
2. manager-as-tool 和 handoff 均为一等能力；
3. RunState 作为暂停/恢复边界，而非把一切塞进 Session metadata；
4. Session 只负责对话历史，RunState 负责未完成执行；
5. guardrail 与 tracing processor 是稳定扩展点；
6. 少量 primitive、复杂编排交给普通代码或独立 orchestration 层。

**不适合直接照搬**

- Python dataclass/Pydantic 具体实现不适合 TypeScript；
- OpenAI 默认 tracing backend 和 Responses 专属 hosted tools 不能成为 Actoviq core 强依赖；
- 当前 OpenAI RunState 已非常复杂，Actoviq 应先实现最小可恢复集合，不要一次复制全部内部状态；
- realtime/voice 是独立低延迟 runtime，不应硬塞进当前文本 loop。

### 8.2 CrewAI

**它有什么**

- Agent、Task、Crew、Flow 四层抽象；
- sequential 与 hierarchical process；
- Crew 级规划、memory、knowledge、guardrail、delegation；
- Flow 的 start/listen/router、事件驱动执行、持久化、checkpoint/fork、HITL；
- ExecutionContext 基于 ContextVar 隔离执行上下文；
- CrewAIEventsBus、typed events、scoped handlers、trace listener；
- 重型模块 lazy import，例如 Memory。

本地源码证据：

- lib/crewai/src/crewai/agent/core.py:170、740、1028、1127；
- lib/crewai/src/crewai/crew.py:159、966、1475-1519；
- lib/crewai/src/crewai/flow/runtime/__init__.py:428、585-691、1920-2028、2532-2698；
- lib/crewai/src/crewai/events/event_bus.py:95、245、572、832；
- lib/crewai/src/crewai/context.py:65-121。

**适合 Actoviq**

1. 把确定性 Flow 和自主 Agent 区分；
2. execution scope 隔离，避免全局 mutable state；
3. checkpoint/fork/HITL 成为 flow/runtime 原生语义；
4. event scope 和 handler 生命周期；
5. 重能力 lazy import/lazy init。

**不适合直接照搬**

- CrewAI 配置和执行路径已经很大，Agent/Crew/Flow 之间存在较高认知成本；
- 全局 event bus 即使有 scope，仍不适合多租户 Node SDK 默认；
- 不能再引入一套与现有 team/workflow 重叠的 Crew abstraction；
- 不应把 planning、memory、knowledge 全部做成 Agent 固有字段。

### 8.3 DeerFlow

**它有什么**

- 基于 LangChain/LangGraph 的完整产品 runtime，而非单纯 SDK；
- create_deerflow_agent 接受 model/tools/middleware/checkpointer；
- feature-driven、有顺序的 middleware：thread data、uploads、sandbox、dangling tool call、guardrail、tool error、summarization、todo、title、memory、vision、subagent、loop detection、token budget、clarification；
- middleware 可 full takeover 或按位置插入；
- 独立 model factory、MCP cache/session pool、persistence、trace context；
- gateway、threads、runs、channels、scheduler、auth 与 harness 分层；
- sandbox provider、warm pool、tool budget、token usage、read-before-write 等产品硬化能力。

本地源码证据：

- backend/packages/harness/deerflow/agents/factory.py:61-145、155-304；
- backend/packages/harness/deerflow/agents/middlewares/；
- backend/packages/harness/deerflow/mcp/cache.py:1-166；
- backend/packages/harness/deerflow/mcp/session_pool.py；
- backend/packages/harness/deerflow/trace_context.py:1-87；
- backend/packages/harness/deerflow/models/factory.py。

**适合 Actoviq**

1. 用 middleware 拆出 compaction、memory、permissions、loop detection、tool error 和 budget；
2. feature/profile 只负责选择 middleware，不直接改主 loop；
3. MCP catalog cache、session pool 和明确 teardown；
4. request trace context 与 run id 分离；
5. harness/runtime 和 gateway/product surface 分层；
6. sandbox provider 与 workspace/file tools 通过 protocol 对接。

**不适合直接照搬**

- DeerFlow 是完整服务产品，其 auth/gateway/channel/database 复杂度不应进入 SDK core；
- middleware 位置注解和较长固定链会带来顺序耦合，Actoviq 应使用有限 stage slot；
- 不引入 LangGraph 作为 Actoviq runtime 必需依赖；
- 不能把所有 feature 都默认开启。

### 8.4 DeepAgents

**它有什么**

- create_deep_agent 在一个 graph 上组合 Todo、Skills、Filesystem、SubAgent、Memory、Summarization、HITL 等 middleware；
- BackendProtocol 抽象 ls/read/grep/glob/write/edit/delete/upload/download；
- SandboxBackendProtocol 在文件 backend 上增加 execute；
- StateBackend、StoreBackend、FilesystemBackend、CompositeBackend、Sandbox adapter；
- inline subagent、compiled subagent 和 async subagent；
- checkpointer 与 store 显式注入；
- permissions 可生成 interrupt，支持 HITL；
- summarization 将淘汰历史 offload 到 backend。

本地源码证据：

- libs/deepagents/deepagents/graph.py:71、359-375、1011-1019；
- libs/deepagents/deepagents/backends/protocol.py:356-924；
- libs/deepagents/deepagents/middleware/subagents.py:36、167、531、737；
- libs/deepagents/deepagents/middleware/async_subagents.py:34、286-795、868；
- libs/deepagents/deepagents/middleware/summarization.py:1654-1819。

**适合 Actoviq**

1. backend protocol 把文件/执行环境从 agent loop 解耦；
2. checkpointer、store 和 backend 分离；
3. subagent 作为 middleware/tool，而不是独立第二套 runtime；
4. history offload 与 summarization 协同；
5. required invariant middleware 与 optional middleware 有明确区别。

**不适合直接照搬**

- create_deep_agent 已经承担大量条件分支，Actoviq 不应再造另一个 God factory；
- DeepAgents 对 LangChain/LangGraph 类型和状态模型依赖很强；
- ephemeral task subagent 默认无后续沟通，而 Actoviq 已有 SendMessage/background，需要保留差异化；
- backend protocol 不应只围绕文件系统，应扩展为 WorkspaceProvider + ArtifactStore，但避免做万能接口。

### 8.5 参考项目综合矩阵

| 设计主题 | OpenAI Agents | CrewAI | DeerFlow | DeepAgents | Actoviq 选择 |
|---|---|---|---|---|---|
| 核心 primitive | 少而清晰 | Agent/Task/Crew/Flow | Product + middleware | Graph + middleware/backend | AgentSpec + Runtime + Tool + RunState |
| 多 agent | as-tool + handoff | delegation + hierarchy | subagent middleware | task/async subagent | asTool、handoff、spawn、workflow 四类 |
| 状态 | Session + RunState | Flow persistence/checkpoint | LangGraph checkpointer + DB | checkpointer + store | SessionStore + CheckpointStore + MemoryStore |
| 扩展 | hooks/guardrail/processor | events/config | ordered middleware | middleware/backend | stage-based middleware + service protocol |
| Provider | model/provider interface | 多 LLM adapter | factory/patch | LangChain model | capability-aware provider-neutral adapter |
| 观测 | trace/span processor | event bus + tracing | trace context + tracing | LangGraph/LangSmith | versioned RunEvent + OpenTelemetry-compatible sink |
| 安全 | guardrail/HITL/sandbox | guardrail/HITL | sandbox + middleware | permission interrupt/backend | policy + durable interrupt + explicit trust tier |
| 应避免 | provider lock-in | 抽象过多 | product complexity | graph lock-in | 不引入新大依赖，不复制全平台 |

## 9. 目标架构

### 9.1 设计原则

1. **最小 core**：定义数据和协议，不做目录扫描、文件写入、后台任务或 UI。
2. **Agent 是配置，Runtime 是执行**：AgentSpec 不持有可变运行状态。
3. **provider-neutral**：canonical item 不以 Anthropic 或 OpenAI 字段命名。
4. **能力协商**：structured output、parallel tools、reasoning、hosted tools、vision、audio、prompt cache 均由 capability 决定。
5. **组合优于特例**：memory/compaction/skills/policy/tracing/subagent 都通过 middleware/service。
6. **安全默认**：有限 turn/deadline；不默认 bypass；不把 vm 称为安全沙箱。
7. **持久边界清晰**：Session history、Run checkpoint、long-term memory、artifact 分开。
8. **一致的取消与预算**：父 run 的 deadline、signal、token/cost/tool/subagent budget 传播到所有 child。
9. **可观测且可重放**：事件有 version、sequence、trace/span 和明确一致性。
10. **兼容迁移**：现有 createAgentSdk、AgentSession、ModelApi 通过 adapter 继续工作。

### 9.2 目标分层

~~~mermaid
flowchart TB
    SURFACES["TUI / GUI / CLI / Bridge / Server"] --> FACADE["Compatibility facade"]
    SURFACES --> API["New public API"]
    FACADE --> RUNTIME["AgentRuntime"]
    API --> RUNTIME
    RUNTIME --> CORE["Core: AgentSpec, Items, RunContext, RunState, Result, Events"]
    RUNTIME --> MW["Middleware pipeline"]
    RUNTIME --> SERVICES["RuntimeServices"]
    MW --> POLICY["Guardrail / Permission / Budget / Retry / Compaction"]
    SERVICES --> PROVIDERS["ModelProvider registry"]
    SERVICES --> TOOLS["ToolRegistry + MCP"]
    SERVICES --> STATE["SessionStore + CheckpointStore + MemoryStore"]
    SERVICES --> WORKSPACE["WorkspaceProvider + ArtifactStore"]
    SERVICES --> OBS["EventSink + TraceProcessor"]
    RUNTIME --> ORCH["asTool / handoff / spawn / workflow"]
    ORCH --> RUNTIME
~~~

### 9.3 包与导出边界

先不拆多个 npm 包，先用 subpath exports 降低迁移风险：

- actoviq-agent-sdk：兼容 façade；
- actoviq-agent-sdk/core：纯类型、schema、AgentSpec、items、errors；
- actoviq-agent-sdk/runtime：AgentRuntime、RunHandle、middleware；
- actoviq-agent-sdk/providers/anthropic；
- actoviq-agent-sdk/providers/openai-responses；
- actoviq-agent-sdk/providers/openai-chat；
- actoviq-agent-sdk/orchestration；
- actoviq-agent-sdk/node：文件、SQLite、process、worktree、local MCP；
- actoviq-agent-sdk/compat：旧 ModelApi、MessageParam、AgentSession adapter。

GUI/TUI/Bridge 继续随仓库发布，但不能从 core 被反向 import。是否最终拆成 monorepo 包，以 0.6 preview 的 bundle、发布和依赖数据决定，不作为第一阶段前置条件。

## 10. 目标公共契约

以下接口是规划级契约；实现时允许调整命名，但语义不能缺失。

~~~ts
export interface AgentSpec<TContext = unknown, TOutput = string> {
  id: string;
  name: string;
  description?: string;
  instructions: PromptSource<TContext>;
  model?: ModelRef;
  tools?: ToolRef[];
  handoffs?: HandoffSpec<TContext>[];
  output?: OutputSchema<TOutput>;
  inputGuardrails?: Guardrail<TContext>[];
  outputGuardrails?: Guardrail<TContext, TOutput>[];
  middleware?: AgentMiddleware<TContext>[];
  limits?: Partial<RunLimits>;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AgentRuntime {
  run<TContext, TOutput>(
    agent: AgentSpec<TContext, TOutput>,
    input: AgentInput,
    options?: RunOptions<TContext>,
  ): Promise<RunResult<TOutput>>;

  stream<TContext, TOutput>(
    agent: AgentSpec<TContext, TOutput>,
    input: AgentInput,
    options?: RunOptions<TContext>,
  ): RunHandle<TOutput>;

  resume<TOutput>(
    state: SerializedRunState,
    decisions?: InterruptionDecision[],
  ): RunHandle<TOutput>;

  close(): Promise<void>;
}

export interface RunHandle<TOutput> extends AsyncIterable<RunEvent> {
  readonly runId: string;
  readonly result: Promise<RunResult<TOutput>>;
  cancel(reason?: string): void;
  snapshot(): Promise<SerializedRunState>;
}
~~~

### 10.1 Canonical items

Canonical item 至少支持：

- user/assistant/system text；
- image、audio、document、artifact reference；
- reasoning item（默认 opaque，不要求所有 provider 可读）；
- tool call、tool result；
- handoff call/result；
- refusal/error；
- provider extension/raw item，用于无损 round-trip。

禁止继续使用 max_tokens、tool_choice、stop_reason 等 provider-specific 字段作为 core API。它们分别变为 maxOutputTokens、toolPolicy、finishReason，再由 adapter 映射。

### 10.2 ModelProvider

~~~ts
export interface ModelProvider {
  readonly id: string;
  resolve(model: ModelRef): Promise<ResolvedModel>;
  capabilities(model: ResolvedModel): Promise<ModelCapabilities>;
  generate(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse>;
  stream(request: ModelRequest, context: ModelCallContext): ModelStream;
}
~~~

要求：

- OpenAI 优先实现 Responses adapter；Chat Completions 只做兼容；
- Anthropic adapter 直接处理 Anthropic 能力，不再让其他 provider 伪装为 Anthropic message；
- capability 不从 hostname 猜测；
- fallback 必须声明兼容策略：output schema、tool calling、multimodal 不兼容时提前失败；
- raw provider response 可选择保留，但需受敏感数据策略控制；
- provider retry 只覆盖 transport/request，不自动重放已经执行过的工具。

### 10.3 Tool 与 Policy

Tool descriptor、executor 和 policy 分离：

~~~ts
export interface Tool<TContext, TInput, TOutput> {
  name: string;
  description: string;
  input: Schema<TInput>;
  output?: Schema<TOutput>;
  execute(context: ToolContext<TContext>, input: TInput): Promise<ToolOutput<TOutput>>;
  behavior?: {
    effect: "read" | "idempotent-write" | "side-effect";
    concurrencyKey?: string | ((input: TInput) => string);
    timeoutMs?: number;
    requiresApproval?: boolean | ApprovalResolver<TContext, TInput>;
  };
}
~~~

规则：

- 默认 effect 为 side-effect，不能因为缺少 isDestructive 就推断安全；
- read 可并行；idempotent-write 仅在相同 idempotency key 下重试；side-effect 不自动重试；
- 所有 tool 都继承 run signal/deadline，并可设置更短 timeout；
- tool error 形成结构化 ToolFailure，模型可见文本由 ErrorFormatter 决定；
- artifact 是一等输出，不先把超大结果完整塞入模型文本；
- MCP tool 映射到同一 Tool contract，不另走权限旁路。

### 10.4 Middleware

不采用无限自由的 around-everything 链，而采用有限 stage：

1. prepareInput；
2. beforeRun；
3. wrapModelCall；
4. afterModelResponse；
5. beforeToolCall；
6. wrapToolCall；
7. afterToolCall；
8. beforeHandoff；
9. afterTurn；
10. finalizeOutput；
11. afterRun/onError。

内建不可移除 invariant：

- tool call/result 配对；
- schema validation；
- session revision；
- cancellation/deadline；
- event sequence；
- sensitive data redaction boundary。

可选 middleware：

- Prompt/Context composer；
- Skills；
- Memory retrieval/writeback；
- Compaction/offload；
- Permissions/HITL；
- Input/output/tool guardrails；
- Retry/error mapping；
- Loop detection；
- Token/cost/subagent budget；
- Tracing/metrics；
- Todo/plan；
- Subagent；
- Title/dream 等产品功能。

顺序由 stage + priority 数字确定；同一 priority 冲突在 runtime 创建时失败，不能靠 import 顺序决定。

### 10.5 Session、RunState、Memory、Artifact

四类状态必须分开：

| 状态 | 职责 | 默认实现 |
|---|---|---|
| SessionStore | 已提交的对话 item 与 session metadata | SQLite；JSON compat |
| CheckpointStore | 未完成 run、interruption、cursor、pending tool/handoff | SQLite；可插拔远程 store |
| MemoryStore | 跨 turn/session 的长期记忆 | 当前文件 memory adapter |
| ArtifactStore | 大 tool output、文件、图片、报告 | 当前 artifact 文件 adapter |

SessionStore 必须支持 expectedRevision：

~~~ts
load(sessionId): Promise<{ session: SessionSnapshot; revision: string }>;
append(sessionId, items, expectedRevision): Promise<{ revision: string }>;
~~~

RunState 至少持久化：

- schemaVersion、runId、trace context；
- agent identity/config digest；
- input、generated items、当前 turn/cursor；
- pending tool/handoff/interruption；
- total usage 和 budgets；
- sessionId + expected revision；
- provider continuation id/raw opaque state；
- workspace identity；
- child run references；
- context serializer 标记。

不序列化函数、AbortSignal、live client、API key 或完整 executor。恢复时由 RuntimeRegistry 根据稳定 id 重新解析。

### 10.6 Orchestration

统一四种语义：

1. **Agent as tool**：manager 保留对话控制权，child 返回 tool result；
2. **Handoff**：控制权和经过 filter 的对话转给目标 agent；
3. **Workflow**：代码/图决定顺序、并发、条件和 join；
4. **Spawn**：durable background child，父 run 可等待、订阅或稍后读取。

Team、Swarm、Reviewer、Panel、Router 都由这四种 primitive 组合：

- panel = parallel asTool + reducer；
- reviewer = executor asTool + reviewer asTool + policy；
- swarm = spawn + mailbox/event channel；
- router = AgentSelector + handoff/asTool；
- workflow graph = code orchestration；
- SendMessage = 向 child run 的 durable input channel 追加消息。

每个 child 必须继承：

- traceId、parentSpanId；
- deadline 和 signal；
- security policy；
- tenant/session namespace；
- token/cost/tool/subagent budget；
- concurrency controller；
- workspace policy。

### 10.7 安全与 Workflow 执行

定义两种信任级别：

- trusted：仓库内、用户明确安装的 workflow，可在进程内执行，但仍有 deadline 与 capability；
- untrusted：外部生成/上传脚本，默认拒绝；必须使用 SandboxWorkflowExecutor。

SandboxWorkflowExecutor 分级：

1. local isolated process：不继承 secret/env，只通过受限 JSON-RPC；防止误操作，不宣称对抗恶意宿主逃逸；
2. container/remote sandbox：CPU、memory、wall time、filesystem、network policy；用于真正不可信脚本；
3. node:vm 仅保留为 trusted compatibility executor，并修改所有“sandbox”文案。

## 11. 默认 Runtime 策略

新 API 使用安全有限默认值；旧 façade 在兼容期保留行为并发出一次 deprecation diagnostic。

| 策略 | Core 默认 | Coding profile | Compat |
|---|---:|---:|---:|
| maxTurns | 32 | 96 | 保留当前配置；Infinity 时告警 |
| runDeadline | 15 分钟 | 60 分钟 | 不强制改变 |
| modelCallTimeout | 120 秒 | 180 秒 | 保留现值 |
| toolTimeout | 120 秒 | tool 可覆盖；shell 独立配置 | 未声明时告警 |
| hookTimeout | 30 秒 | 30 秒 | 新增上限 |
| parallel tools | 10 | 10 | 保持 |
| subagent depth | 1 | 2 | 保持旧配置 |
| subagent fanout | 8 | 8 | 保持 |
| stream buffer | 256 events | 512 events | delta 合并 |
| permission | default/policy | default/policy | CLI 的 bypass 必须显式参数 |

支持矩阵更新为：

- SDK/runtime：Node 22 和 Node 24 LTS；
- Electron desktop build：Node 22/24；
- 移除 package.json 的 Node >=18 承诺；
- CI 用 22/24，停止把 EOL Node 20 作为支持目标。

## 12. 分阶段实施规划

### Phase 0：生产止血与可测基线（1-2 周）

**实施**

1. per-session mutex，拒绝同一 session 并发写或排队串行；
2. 给 SessionStore 增加 revision 字段和最小 schema validation；
3. 有界 AgentRunStream；支持 cancel 和 iterator.return；
4. tool/MCP/hook timeout 与 signal 传播；
5. fanoutByRun 清理；AgentPool 改成 client/runtime 所有；
6. MCP key 使用完整配置指纹，catalog cache，listTools 并行；
7. team 不再硬编码 bypass；run 级自动重试降为 0，provider retry 保留；
8. 修复 workDir 持久化；
9. workflow vm 文案降级为 trusted executor，不可信输入默认拒绝；
10. 正确聚合 usage。

**验收**

- 100 个并发 same-session send 不丢消息；行为要么严格串行，要么明确 ConflictError；
- 无人消费的 100 万 delta 测试内存不超过配置 buffer 对应上限；
- abort 后模型、local tool、MCP、hook 均在限定时间内退出；
- side-effect tool 在 transport failure 下只执行一次；
- 每个 run 完成后 fanout/context map 回到基线；
- team 默认继承调用方 permission；
- 现有 compat tests 全部通过。

### Phase 1：Core contract 与 Provider v2（2-3 周）

**实施**

1. 新建 core subpath：AgentSpec、canonical items、RunContext、RunResult、RunError；
2. ModelProvider/ModelCapabilities/ModelRegistry；
3. OpenAI Responses、OpenAI Chat compat、Anthropic 三个 adapter；
4. provider contract test kit；
5. structured output 和 multimodal item；
6. UsageAccumulator；
7. 旧 ModelApi adapter。

**验收**

- 同一 fake contract suite 跑过三个 adapter；
- text/tool/structured/image/reasoning opaque item round-trip；
- 不支持能力在请求前抛 CapabilityError，不依赖 hostname；
- 旧 createAgentSdk 可以通过 adapter 使用新 provider；
- 每个 run 的 total usage 等于所有 model call 累加。

### Phase 2：AgentRuntime 与 Middleware（2-3 周）

**实施**

1. 抽出 RuntimeServices 和 AgentRuntime；
2. 实现 stage-based middleware；
3. 将 prompt、permissions、hooks、compaction、memory、skills、loop detection 移出 conversationEngine；
4. createAgentSdk 变成 compat façade；
5. 可选能力 lazy init；
6. 根导出按 subpath 收敛。

**验收**

- 最小 text agent 启动时不访问 session/memory/skill/agent 目录，不创建 timer/subprocess；
- 禁用 memory 后不读取 memory 文件、不改变 prompt；
- middleware 顺序在构建时可打印和验证；
- conversation loop 只负责状态机，不直接 import buddy/dream/team/gui；
- compat 示例输出与旧基线一致。

### Phase 3：Durable state、HITL 与事件（3 周）

**实施**

1. SessionStore v2、CheckpointStore、MemoryStore、ArtifactStore；
2. SQLite Node driver，JSON v1 migration/compat；
3. SerializedRunState 和 runtime.resume；
4. Interruption/Decision；
5. RunEvent envelope、EventSink、TraceProcessor；
6. OpenTelemetry-compatible exporter，不强制依赖特定后台；
7. append journal + snapshot compaction。

**验收**

- 在 tool approval 前持久化、杀进程、重启、approve 后继续；
- 重启恢复不会重复已提交的 side-effect tool；
- session v1 文件可迁移，失败时保留原文件；
- event sequence 单调、可去重，parent/child trace 可还原；
- session append 写入量只与新增 item 相关，不与完整历史线性相关。

### Phase 4：统一多 Agent 与 Workflow（3-4 周）

**实施**

1. Agent.asTool；
2. HandoffSpec + input filter；
3. Spawn/background durable child；
4. WorkflowGraph + reducer；
5. team/swarm/router/workflow 迁移为 preset；
6. child budget、deadline、policy、workspace、trace 继承；
7. team 成员复用 RuntimeServices，不 create 完整 SDK；
8. trusted/untrusted WorkflowExecutor。

**验收**

- manager-as-tool 和 handoff 有不同、可测试的 conversation ownership；
- 10-member team 只创建一个 provider/MCP/session service 集合；
- 父 cancel 能取消整棵 child run tree；
- child failure policy 可选 fail-fast、collect、retry-safe；
- background child 重启后仍可查询/继续；
- 恶意 workflow 测试不能获取宿主 secret，超限会被 executor 终止。

### Phase 5：Agent profiles 与产品表面迁移（2-3 周）

**实施**

1. chat、coding、research、workflow、supervisor、background 六个 profile；
2. TUI/GUI 改用 RunEvent，不直接依赖内部 AgentEvent 特例；
3. Bridge 转为 provider/runtime adapter，而不是第二套 SDK；
4. scheduler/manager/issue 集成新 spawn/checkpoint；
5. docs、examples、migration guide、ADR；
6. deprecation 统计与兼容开关。

**验收**

- 六类 profile 有端到端示例和 acceptance suite；
- TUI/GUI/Bridge 在相同 run 上看到同一事件语义；
- 旧 API 示例全部有新 API 对照；
- root API 不再新增平台内部 symbol；
- 0.6 preview 期间收集兼容问题，1.0 前冻结 core contracts。

### Phase 6：1.0 稳定化（2 周）

1. API review 与 public symbol freeze；
2. threat model、failure-mode review、performance baseline；
3. Node 22/24、Windows/Linux/macOS 矩阵；
4. session migration dry-run 与 rollback；
5. changelog、support matrix、semantic version policy；
6. 去除未使用的旧内部路径，但保留 compat façade。

## 13. 测试与验收计划

### 13.1 Contract tests

- ModelProvider：text、stream、tool、parallel tool、structured output、usage、abort、retry、unsupported capability；
- Tool：schema、timeout、abort、idempotency、artifact、permission、MCP parity；
- SessionStore：CAS、append、migration、corrupt data、multi-process conflict；
- CheckpointStore：pause/resume、nested child、pending tool、trace context；
- EventSink：sequence、backpressure、redaction、processor failure。

### 13.2 并发与故障注入

- same-session 1/10/100 并发 turn；
- 1000 session 并发，但受 runtime semaphore 限制；
- provider 在 headers 前、stream 中、tool call 后断线；
- MCP server 重启、catalog 变化、凭据变化、超时；
- session 写盘 ENOSPC、corrupt snapshot、CAS conflict；
- parent cancel、child cancel、deadline race；
- hook/middleware 抛错、超时、返回非法数据；
- team 某成员失败、部分成功、reducer 失败。

### 13.3 安全测试

- permission 继承与 no-bypass；
- workspace path traversal、symlink、worktree resume；
- untrusted workflow 读取 process/env/fs/net/child_process；
- event/trace secret redaction；
- MCP header/env 不出现在日志、state 或 connection key 明文；
- prompt/tool output 注入不绕过 policy；
- tenant namespace 不能读取其他 session/artifact。

### 13.4 性能基线

新增 bench/runtime：

- core import 与 createRuntime cold/warm p50/p95；
- 1、10、100 MCP server catalog warm/cold；
- 10k/100k message session append、load、snapshot；
- 100 万 stream delta 的内存与吞吐；
- 1/4/8/16 member team 的连接、文件句柄、内存、token 和时延；
- compaction 前后 CPU、请求字节和模型成本；
- compat façade 与新 runtime overhead 对比。

门禁：

- 新基线建立后，core p95、内存和写放大回归超过 10% 必须说明；
- stream 内存由 buffer 容量决定，不随总事件数增长；
- warm MCP run 不重复 listTools，除非 TTL/revision 失效；
- team member 数增长不能线性增加 SDK service 实例；
- session append 不重写完整历史。

### 13.5 覆盖率与 CI

- core/runtime/provider/orchestration 行和分支覆盖率至少 85%；
- contract、migration、security acceptance 场景必须 100% 列表化；
- CI：Node 22/24，Linux/Windows；macOS 至少 nightly；
- desktop 单独 Node 22/24；
- package dry-run 验证 subpath exports 和 optional dependency；
- 增加 API Extractor 或等价 public API diff gate。

## 14. 兼容与迁移策略

### 14.1 版本建议

- 0.4.7：仅 P0 hotfix，不引入新大 API；
- 0.5.0：发布当前已存在但未正式对齐的 workflow/team/worktree 能力，并冻结旧 surface；
- 0.6.x：新 core/runtime/provider subpath preview；旧 root façade 默认可用；
- 1.0.0：新契约稳定，旧 façade 标记 deprecated 但继续支持；
- 2.0.0：只有在真实迁移数据证明可行后，才考虑移除旧 façade。

### 14.2 迁移适配器

- LegacyModelApiAdapter：旧 ModelApi ↔ 新 ModelProvider；
- LegacyMessageAdapter：MessageParam/Message ↔ canonical item；
- LegacyAgentClientFacade：createAgentSdk 方法映射到 AgentRuntime；
- LegacySessionAdapter：旧 AgentSession 映射 SessionStore + RunHandle；
- LegacyEventAdapter：新 RunEvent 映射旧 AgentEvent，供 TUI/GUI 过渡；
- JSON v1 migrator：只新增文件/备份后切换，支持 dry-run。

### 14.3 不做的事情

- 不一次性拆成十几个 npm 包；
- 不直接复制 Python 参考项目代码；
- 不把 LangGraph、CrewAI 或 OpenAI backend 设为强依赖；
- 不在本轮实现完整 realtime/voice；
- 不用更多 prompt 特例替代 runtime contract；
- 不在没有 migration/contract test 前删除现有 Bridge/TUI/GUI 路径。

## 15. 关键 ADR

实施前必须落下以下 Architecture Decision Record：

1. ADR-001：canonical item 与 provider extension；
2. ADR-002：AgentSpec/AgentRuntime 边界；
3. ADR-003：middleware stage 与不可移除 invariant；
4. ADR-004：SessionStore/CheckpointStore/MemoryStore/ArtifactStore 分离；
5. ADR-005：manager-as-tool、handoff、spawn、workflow 语义；
6. ADR-006：trusted/untrusted workflow executor；
7. ADR-007：event/trace schema 与敏感数据；
8. ADR-008：compat façade 和版本生命周期；
9. ADR-009：Node 22/24 支持矩阵；
10. ADR-010：retry/idempotency/exactly-once 承诺边界。

每个 ADR 必须包含：上下文、决定、拒绝的方案、兼容影响、runtime 成本、测试方式、回滚方式。

## 16. 最终 Definition of Done

只有同时满足以下条件，才能宣称 Actoviq 是“适合构建多种类型 agent 的通用 SDK”：

1. chat/coding/research/workflow/supervisor/background 六类 profile 共用同一 AgentRuntime；
2. provider adapter 通过统一 contract suite，能力不靠 hostname 推断；
3. structured output、guardrail、asTool、handoff、spawn、workflow 都是一等 API；
4. session 并发无数据丢失，run 可序列化暂停/恢复；
5. stream、tool、MCP、hook 和 child run 均有有界资源与统一取消；
6. team 不创建 N 个完整 SDK，不默认绕过权限；
7. workflow 明确信任等级，node:vm 不再被宣称为安全沙箱；
8. 事件可版本化、排序、关联 parent/child 并输出 trace；
9. 最小 agent 不加载 memory/team/gui/bridge 等可选能力；
10. 旧 createAgentSdk 用户有无损迁移路径和至少一个稳定大版本的兼容窗口；
11. runtime 性能、故障、安全和迁移测试进入 CI；
12. README、CHANGELOG、package version、Node support 和实现事实一致。

## 17. 推荐立即创建的工作项

按依赖顺序：

1. session-concurrency-and-revision；
2. bounded-run-stream-and-cancel；
3. unified-deadline-for-model-tool-mcp-hooks；
4. mcp-catalog-cache-and-config-fingerprint；
5. team-policy-and-retry-safety；
6. workflow-trust-boundary；
7. run-usage-aggregation；
8. core-item-and-provider-contract-rfc；
9. runtime-middleware-rfc；
10. durable-run-state-rfc；
11. orchestration-semantics-rfc；
12. compat-facade-and-migration-suite。

前六项可作为 0.4.7 hardening 并行开展；后六项按 ADR 和 contract test 先行，禁止直接在 agentClient.ts 中继续追加分支。

## 18. 参考资料

### 官方资料

- OpenAI Agents SDK 文档：https://openai.github.io/openai-agents-python/
- Agents：https://openai.github.io/openai-agents-python/agents/
- Running agents：https://openai.github.io/openai-agents-python/running_agents/
- Agent orchestration：https://openai.github.io/openai-agents-python/multi_agent/
- Handoffs：https://openai.github.io/openai-agents-python/handoffs/
- Guardrails：https://openai.github.io/openai-agents-python/guardrails/
- Human in the loop：https://openai.github.io/openai-agents-python/human_in_the_loop/
- Sessions：https://openai.github.io/openai-agents-python/sessions/
- Context：https://openai.github.io/openai-agents-python/context/
- Tracing：https://openai.github.io/openai-agents-python/tracing/
- Node.js vm 安全边界：https://nodejs.org/api/vm.html
- Node.js release status：https://nodejs.org/en/about/previous-releases

### 本地参考源码

- CrewAI：E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\crewAI
- DeerFlow：E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow
- DeepAgents：E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents
- OpenAI Agents Python：E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python

### Actoviq 关键审计文件

- src/index.ts
- src/types.ts
- src/runtime/agentClient.ts
- src/runtime/conversationEngine.ts
- src/runtime/agentSession.ts
- src/runtime/asyncQueue.ts
- src/runtime/actoviqAgents.ts
- src/mcp/connectionManager.ts
- src/provider/openai-model-api.ts
- src/storage/sessionStore.ts
- src/team/teamRuntime.ts
- src/team/agentPool.ts
- src/workflow/workflowScriptRuntime.ts
- package.json
- .github/workflows/ci.yml
