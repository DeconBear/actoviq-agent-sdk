# Actoviq Agent SDK 1.0 迁移指南

> 适用范围：从 package root 的 0.x `createAgentSdk` / `ActoviqAgentClient` 逐步迁移到 1.0 职责 subpath。
>
> 事实边界：当前工作树版本为 `1.0.0`。这表示本地公共契约已冻结并通过本仓库门禁；是否发布到 npm、以及各 OS 的远端 CI 结果，仍以对应 release/CI 记录为准。
>
> 相关决策：[ADR-001](../adr/ADR-001-canonical-item-and-provider-extension.md)、[ADR-002](../adr/ADR-002-agent-spec-and-runtime-boundary.md)、[ADR-008](../adr/ADR-008-compat-facade-lifecycle.md)。

## 1. 先读结论

迁移不是“把 import 路径批量替换”这么简单。旧 API 是一个包含 session、memory、skills、agents、team、Bridge 和 UI 适配的完整 client；新 API 把它拆为声明、runtime、provider、可选 service、event 和 orchestration contract。

推荐分四步，每一步都可单独回滚：

1. **先迁 provider**：新 `ModelProvider` 通过 `ModelProviderLegacyAdapter` 继续驱动旧 `createAgentSdk`。
2. **再迁最小 agent**：用 `AgentSpec + AgentRuntime` 迁移无 session、无工具的 text run。
3. **逐项接回能力**：tool/policy、session/checkpoint、middleware、event、orchestration 分别验收。
4. **最后迁产品表面**：TUI/GUI/Bridge 统一消费 `RunEvent` 后，才停止依赖旧 `AgentEvent`。

不要在同一发布中同时替换 provider、runtime、session、event 和 UI；否则无法定位行为漂移，也无法安全回滚。

## 2. 当前交付状态

| 能力 | 当前实现 | 迁移判断 |
|---|---|---|
| Canonical item / AgentSpec / RunResult | 已有 `/core` | 1.0 public contract |
| ModelRegistry + 3 个 adapter | 已有 `/providers` | 已有统一 provider contract suite |
| 旧↔新 ModelApi adapter | 两个方向均已实现 | 可作为第一步 |
| AgentRuntime / middleware / lazy services | 已有 `/runtime` | 可迁最小 agent |
| SQLite store、session/checkpoint adapter | 已有 `/node` | legacy converter 与 runtime cutover E2E 已有；生产仍先 dry-run/canary |
| RunEvent / redaction / OTel-compatible sink | 已有 `/events` | runtime 可用 |
| agent-as-tool/handoff/background/graph/preset | 已有 `/orchestration` | 1.0 public contract |
| 六类 profile | 已有 `/profiles` | 有共享 runtime acceptance test |
| trusted/untrusted workflow executor | 已有 `/workflow` | local process 不是强 sandbox |
| Root compat façade | 继续存在 | 兼容窗口内保留 |
| `createAgentSdk` 真正委托新 AgentRuntime | 未强制改写 | 作为稳定 compat façade 保留；新代码直接使用 runtime subpath |
| CLI/TUI/GUI/旧 Bridge 的事件表面 | 已接 `AgentEvent → RunEvent → shared semantics` | 迁移期间保留旧 producer，四个表面消费同一语义 |
| 原生 Runtime Bridge | `AgentRuntimeBridgeAdapter` | 只包装现有 runtime，不创建第二套 SDK/services |
| Legacy message/session/event adapter | `/node` 与 `/surfaces` 已公开 | 支持 JSON v1 与产品表面渐进迁移 |
| Compat 统计覆盖全部旧 API | 尚未完成 | 当前只记录 `createAgentSdk` |

## 3. Subpath 对照表

| 新 import | 职责 | 不应放入 |
|---|---|---|
| `actoviq-agent-sdk/core` | AgentSpec、canonical item、RunContext/Result/Error、Usage | provider client、filesystem、UI |
| `actoviq-agent-sdk/providers` | ModelProvider、capabilities、registry、transport、adapter | conversation/session policy |
| `actoviq-agent-sdk/runtime` | AgentRuntime、RunHandle、RuntimeServices、middleware、tool/state | GUI/team 特例 |
| `actoviq-agent-sdk/events` | RunEvent、processor/sink、trace exporter adapter | provider secret、完整 raw response 默认值 |
| `actoviq-agent-sdk/surfaces` | RunEvent 产品语义投影、legacy event adapter、runtime Bridge adapter | provider/runtime/service ownership |
| `actoviq-agent-sdk/orchestration` | child scope、asTool、handoff、background、WorkflowGraph/presets | 第二套 provider/runtime |
| `actoviq-agent-sdk/workflow` | trusted/untrusted script executor | 把 `node:vm` 宣称为 sandbox |
| `actoviq-agent-sdk/profiles` | chat/coding/research/workflow/supervisor/background 组合 | 自建 engine |
| `actoviq-agent-sdk/node` | SQLite storage 与 runtime adapter | core import-time I/O |
| `actoviq-agent-sdk/compat` | 旧 root surface、provider adapters、diagnostics | 新功能扩张 |
| `actoviq-agent-sdk` | 冻结的 legacy root API | 新架构 symbol |

## 4. 最小 text agent：旧 → 新

### 4.1 旧 API

```ts
import { createAgentSdk } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1-mini',
});

try {
  const result = await sdk.run('用一句话说明 CAS。', {
    systemPrompt: '回答要简洁。',
  });
  console.log(result.text);
} finally {
  await sdk.close();
}
```

旧 client 构造的是完整 façade，结果主要读取 `text`，事件是 `AgentEvent`。

### 4.2 新 API

```ts
import type { AgentSpec } from 'actoviq-agent-sdk/core';
import {
  ModelRegistry,
  OpenAIResponsesProvider,
} from 'actoviq-agent-sdk/providers';
import { AgentRuntime } from 'actoviq-agent-sdk/runtime';

const provider = new OpenAIResponsesProvider({
  apiKey: process.env.OPENAI_API_KEY,
});
const runtime = new AgentRuntime({
  models: new ModelRegistry([provider]),
});
const agent: AgentSpec = {
  id: 'concise-chat',
  name: 'Concise Chat',
  instructions: '回答要简洁。',
  model: 'openai-responses:gpt-4.1-mini',
};

try {
  const result = await runtime.run(agent, '用一句话说明 CAS。');
  console.log(result.output);
  console.log(result.usage.totalTokens);
} finally {
  await runtime.close();
}
```

差异：

- agent 是不可变声明，runtime 是资源/执行 owner；
- model reference 显式包含 provider id；只有一个 provider 时也可由 registry 作为默认，但生产配置建议显式；
- 新结果读取 `output`、`items`、聚合 `usage`；
- 未配置 session/memory/skills 时不会因最小 run 自动创建这些能力；
- 必须由 host `close()` runtime。

## 5. Provider 先行迁移

这是风险最低的第一步，因为可以保持旧 client/session/event/result 形状。

### 5.1 新 Provider 驱动旧 createAgentSdk

```ts
import { createAgentSdk } from 'actoviq-agent-sdk/compat';
import {
  ModelProviderLegacyAdapter,
  OpenAIResponsesProvider,
} from 'actoviq-agent-sdk/providers';

const provider = new OpenAIResponsesProvider({
  apiKey: process.env.OPENAI_API_KEY,
});
const sdk = await createAgentSdk({
  model: 'gpt-4.1-mini',
  modelApi: new ModelProviderLegacyAdapter(provider),
});

try {
  const legacyResult = await sdk.run('hello');
  console.log(legacyResult.text);
} finally {
  await sdk.close();
}
```

这条路径已有 [`tests/compat-provider-runtime.spec.ts`](../../tests/compat-provider-runtime.spec.ts) 证明基本 text/usage 输出保持旧形状，但不能据此推断所有旧 provider 私有 block 都无损。

### 5.2 旧 ModelApi 驱动新 AgentRuntime

```ts
import { LegacyModelApiProvider, ModelRegistry } from 'actoviq-agent-sdk/providers';
import { AgentRuntime } from 'actoviq-agent-sdk/runtime';

const provider = new LegacyModelApiProvider({ modelApi: existingModelApi });
const runtime = new AgentRuntime({
  models: new ModelRegistry([provider]),
  defaultModel: 'legacy:existing-model',
});
```

适合 runtime 先迁移而 provider client 暂时不动的场景。

### 5.3 Adapter 的已知边界

- 覆盖 text、image、tool、reasoning、usage 和常见 raw item 映射；
- 新 structured item 在旧 message 中可能表现为 JSON text；
- 旧消息模型无法表达的模态可能降级为 raw/JSON text；
- `includeRawResponse` 会扩大敏感数据与存储范围，默认不要开启；
- adapter 是过渡层，不应长期成为所有请求的双重转换链。

## 6. Message / Result / Error 迁移

### 6.1 类型对照

| 旧类型/字段 | 新类型/字段 | 迁移动作 |
|---|---|---|
| `MessageParam` | `InputItem` | 显式映射 role/content block |
| `Message` | `ModelResponse.output` / `RunResult.items` | 不依赖 provider message envelope |
| `AgentRunResult.text` | `RunResult.output` | output 可为泛型 structured type |
| `AgentRunResult.messages` | canonical transcript/session store | 不再读取 provider-shaped history |
| `AgentRunResult.toolCalls` | `tool_call`/`tool_result` items + RunEvent | 以 call id 关联 |
| `AgentRunResult.requests` | event/trace + aggregate usage | 不假设旧 request summary 永远存在 |
| provider error | `RunError` / `CapabilityError` / `ToolExecutionError` | 按 code/phase/retryable 分类 |

### 6.2 Canonical input 示例

```ts
import type { InputItem } from 'actoviq-agent-sdk/core';

const input: InputItem[] = [
  { type: 'text', role: 'user', text: '识别图片里的对象' },
  {
    type: 'image',
    role: 'user',
    source: { kind: 'url', url: 'https://example.invalid/object.png' },
    detail: 'low',
  },
];

const result = await runtime.run(agent, input);
```

大二进制不要无限 base64 内嵌；优先 file/provider reference 或 `artifact_ref`。

### 6.3 CapabilityError 必须在网络前处理

```ts
import { CapabilityError } from 'actoviq-agent-sdk/core';

try {
  await runtime.run(agent, input);
} catch (error) {
  if (error instanceof CapabilityError) {
    console.error(error.providerId, error.model, error.capability);
  } else {
    throw error;
  }
}
```

不要捕获后无条件换 hostname 重试；应选择能力匹配的 provider/model 或修改请求。

## 7. Streaming 与取消

### 7.1 旧 API

```ts
const stream = sdk.stream('hello');
for await (const event of stream) {
  if (event.type === 'response.text.delta') process.stdout.write(event.delta);
}
const result = await stream.result;
```

### 7.2 新 API

```ts
const handle = runtime.stream(agent, 'hello');

try {
  for await (const event of handle) {
    if (event.type === 'model.text.delta') {
      process.stdout.write(String((event.data as { delta?: unknown }).delta ?? ''));
    }
  }
  const result = await handle.result;
  console.log(result.output);
} catch (error) {
  handle.cancel('consumer failed');
  throw error;
}
```

消费者应把 `event.type` 当可扩展字符串；envelope 的 `schemaVersion/eventId/sequence/runId/traceId` 才是通用语义。实际 model stream event type 以当前 runtime tests/实现为准，不要把旧 `AgentEvent` union 直接 cast 为 `RunEvent`。

新 `RunHandle` 还提供：

```ts
handle.cancel('user requested');
const state = await handle.snapshot();
```

停止消费 iterator 时也要 cancel 或确认 iterator `return()` 已触发期望行为，避免后台 run 继续。

## 8. Tool 与 Permission 迁移

### 8.1 新 RuntimeTool

```ts
import {
  ToolRegistry,
  type RuntimeTool,
} from 'actoviq-agent-sdk/runtime';

const lookup: RuntimeTool<unknown, { id: string }, { value: string }> = {
  descriptor: {
    name: 'lookup',
    description: 'Read one record.',
    input: {
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      parse(value) {
        if (!value || typeof value !== 'object' || typeof (value as any).id !== 'string') {
          throw new TypeError('id is required');
        }
        return { id: (value as any).id };
      },
    },
    behavior: { effect: 'read', timeoutMs: 10_000 },
  },
  async execute(context, input) {
    context.signal.throwIfAborted();
    return { value: { value: await readRecord(input.id) } };
  },
};

const tools = new ToolRegistry([lookup]);
const runtime = new AgentRuntime({ models, tools, toolPolicy });
```

### 8.2 必须显式迁移的语义

- 未声明 `effect` 默认是 `side-effect`；
- `idempotent-write` 必须让下游真正使用 `context.idempotencyKey`；
- `requiresApproval` 或 `ToolPolicy` 可产生 durable interruption；
- `ToolRunner` 不自动 retry；
- schema parse 是运行时验证，不只是给模型看的 JSON Schema；
- workspace/tenant/policy 不能只写进 prompt。

旧 `bypassPermissions` 不应成为 team/profile 默认值。Coding/supervisor/background 必须提供明确 policy middleware/service。

## 9. Middleware 迁移

把旧 hook/feature 放到最窄 stage：

| 旧逻辑 | 建议 stage / owner |
|---|---|
| 输入标准化、memory 注入 | `prepareInput` |
| session start / audit | `beforeRun` |
| model retry/metrics wrapper | `wrapModelCall`，但不得绕过 capability/deadline |
| response policy/normalization | `afterModelResponse` |
| permission 附加检查 | `beforeToolCall` / ToolPolicy |
| tool metrics | `wrapToolCall` / `afterToolCall` |
| handoff policy | `beforeHandoff`（集成仍是门禁） |
| compaction/loop detection | `afterTurn` |
| output parse/format | `finalizeOutput` |
| post-run audit | `afterRun` |
| error classification | `onError` |

```ts
import {
  MiddlewareStage,
  defineMiddleware,
} from 'actoviq-agent-sdk/runtime';

const timing = defineMiddleware({
  name: 'model-timing',
  stage: MiddlewareStage.WrapModelCall,
  priority: 100,
  async handle(context, next) {
    const started = performance.now();
    try {
      return await next();
    } finally {
      recordDuration(performance.now() - started);
    }
  },
});
```

构建后把 `runtime.inspectMiddleware(agent)` 保存为启动诊断。相同 stage+priority 会失败；不要依赖注册顺序。

## 10. Session 与 Checkpoint 迁移

### 10.1 新 runtime 显式注入 session service

```ts
import {
  SqliteRuntimeSessionAdapter,
  SqliteStorageV2,
} from 'actoviq-agent-sdk/node';
import { AgentRuntime, RuntimeServices } from 'actoviq-agent-sdk/runtime';

const storage = await SqliteStorageV2.open({ filename: './state/actoviq.sqlite' });
const services = new RuntimeServices({
  sessions: {
    description: 'tenant-scoped SQLite sessions',
    factory: () => new SqliteRuntimeSessionAdapter({ store: storage.sessions }),
  },
});
const runtime = new AgentRuntime({ models, services });

try {
  const result = await runtime.run(agent, 'continue', {
    tenantId: 'tenant-a',
    sessionId: 'session-42',
  });
} finally {
  await runtime.close();
  await storage.close(); // adapter 不拥有共享 storage connection
}
```

不传 `sessionId` 时，runtime 不会 resolve `sessions` service。多租户 host 必须显式传 tenantId，不要共享 `default` namespace。

### 10.2 Checkpoint / HITL

```ts
import {
  SqliteRunCheckpointAdapter,
  SqliteStorageV2,
} from 'actoviq-agent-sdk/node';

const storage = await SqliteStorageV2.open({ filename: './state/actoviq.sqlite' });
const checkpoints = new SqliteRunCheckpointAdapter({
  store: storage.checkpoints,
  tenantId: 'tenant-a',
});
const runtime = new AgentRuntime({ models, tools, checkpointStore: checkpoints });

const handle = runtime.stream(agent, '执行需要审批的操作');
const interrupted = await handle.result;
const state = await handle.snapshot();

if (interrupted.status === 'interrupted' && state.pendingTool?.interruptionId) {
  const resumed = runtime.resume(state, [{
    interruptionId: state.pendingTool.interruptionId,
    outcome: 'approve',
  }]);
  console.log((await resumed.result).output);
}
```

生产系统应从 durable checkpoint store 重新加载 state，而不是依赖同进程变量。`started + side-effect` 恢复会要求 reconciliation，不会自动重放。

JSON v1 → SQLite 的完整 dry-run/cutover/rollback 见 [迁移 Runbook](./11-json-v1-to-sqlite-migration-runbook.md)。

## 11. Event 表面迁移

### 11.1 旧/新差异

| 旧 AgentEvent | 新 RunEvent |
|---|---|
| 大型 discriminated union | 稳定 envelope + 可扩展 type/data |
| 部分事件缺少统一 id/sequence | `eventId` + per-run `sequence` |
| parent/child 由产品特例表达 | `traceId/spanId/parentSpanId/parentRunId` |
| surface 自己转换 | processor/sink pipeline |
| redaction 依赖调用路径 | runtime 默认 key-based redaction |

### 11.2 已落地的双轨迁移

新 runtime 的 `RunHandle` 直接产生 `RunEvent`。旧 CLI/TUI/GUI/Bridge producer 暂时仍产生 `AgentEvent`，但在产品入口立刻经过同一条迁移链：

```text
AgentEvent → LegacyAgentEventRunEventAdapter → SharedRunEventSurfaceProjector
                                                ├─ cli
                                                ├─ tui
                                                ├─ gui
                                                └─ bridge
```

可导入的迁移组件位于 `actoviq-agent-sdk/surfaces`：

- `LegacyAgentEventRunEventAdapter`：补齐 event id、per-run sequence 与 trace；
- `RunEventSemanticProjector` / `SharedRunEventSurfaceProjector`：统一 text/reasoning/tool/usage/error/terminal 语义并执行 redaction；
- `RunEventLegacyCompatAdapter`：在旧 consumer 尚未迁完时将可表达事件映射回 `AgentEvent`；
- `LegacySurfaceEventPipeline`：旧产品入口的一步式 pipeline；
- `AgentRuntimeBridgeAdapter`：新 Bridge 对现有 `AgentRuntime + AgentSpec` 的薄包装。

原生 Bridge 示例：

```ts
import { AgentRuntimeBridgeAdapter } from 'actoviq-agent-sdk/surfaces';

const bridge = new AgentRuntimeBridgeAdapter({ runtime, agent });
const handle = bridge.stream('hello');

for await (const event of handle) {
  // SurfaceSemanticEvent：已排序、带 trace、已做敏感字段清理。
  renderBridgeEvent(event);
}
const result = await handle.result;
```

`AgentRuntimeBridgeAdapter` 没有 `close()`，也不会创建 provider、runtime 或 service container；生命周期始终由 host 对传入的 `runtime` 负责。旧 `ActoviqCleanBridgeCompatSdk` 继续存在以保证 0.x 行为，但不再作为新架构范式。

## 12. Orchestration 迁移

| 旧概念 | 新 primitive/preset | Conversation ownership |
|---|---|---|
| manager 调专家 | `agentAsTool()` / `AgentTool` | manager 保持 owner |
| router 转交专家 | `executeHandoff()` / `HandoffSpec` | target 接管 owner |
| async subagent/task | `BackgroundChildManager` | 独立 durable child |
| ModelTeam panel | `panelPreset()` / `teamPreset()` | graph nodes + reducer |
| reviewer | `reviewerPreset()` | author/reviewers/reducer |
| router | `routerPreset()` | conditional graph |
| swarm | `swarmPreset()` | conditional routes + optional reducer |
| workflow | `WorkflowGraph` + `agentWorkflowNode()` | graph 本身不接管对话 |

所有 child 都必须从 root `OrchestrationScope` 派生并共享 services、budget、concurrency、deadline、policy、tenant/workspace 与 trace。不要在 node/member 内 `createAgentSdk()`。

迁移验收至少检查：

- manager-as-tool 前后 owner 不变；handoff 后 owner 改为 target；
- parent cancel 能取消 child tree；
- 10 个成员不会初始化 10 套 provider/MCP/session service；
- side-effect child 不进入 retry-safe；
- background 重启后可 query/resume 或进入 reconciliation。

## 13. 六类 Profile

```ts
import { buildProfile, runProfile } from 'actoviq-agent-sdk/profiles';

const chat = buildProfile('chat', {
  model: 'openai-responses:gpt-4.1-mini',
  optIns: { memory: false, skills: false, compaction: false },
});

const result = await runProfile(runtime, chat, 'hello');
```

| Profile | 必要边界 | 默认可选能力 |
|---|---|---|
| chat | minimal、deny-by-default、无 workspace | memory/skills/compaction 均 opt-in |
| coding | workspace service、permission/workspace middleware、read/write tools | shell/test/git 按 policy |
| research | artifact service、citation middleware、search/artifact tools | fetch/crawl |
| workflow | checkpoint、scope/determinism middleware、WorkflowGraph reducer | approval |
| supervisor | orchestration service、policy/scope、spawn、child budget | as-tool/handoff |
| background | checkpoint/background service、durable child | query/cancel |

`buildProfile()` 只声明 dependency reference；它不会凭空提供 tool/service/middleware。使用 `runProfile()` 可在网络请求前检查缺失组合。六类共享 runtime 的可执行示例在 [`examples/profiles/all-profiles.ts`](../../examples/profiles/all-profiles.ts)，验收在 [`tests/profiles-v2.spec.ts`](../../tests/profiles-v2.spec.ts)。执行 `npm run example:profiles` 可在不访问网络的情况下验证组合路径。

### 13.1 现有示例 → 1.0 API 对照

下表覆盖仓库当前所有旧 `.ts` 示例。标记“compat 保留”的能力没有被伪装成新 core symbol；它们继续可用，但新系统应通过右栏的 runtime 组合点扩展。

| 旧示例 | 1.0 对照 / 迁移动作 |
|---|---|
| `actoviq-quickstart.ts` | 本文 4.2：`AgentSpec + ModelRegistry + AgentRuntime` |
| `actoviq-agent-helpers.ts` | `/profiles` + `/orchestration` 的 `agentAsTool`、handoff、spawn |
| `actoviq-session.ts` | `/node` 的 `SqliteRuntimeSessionAdapter` 注入 `RuntimeServices.sessions` |
| `actoviq-stream-loop.ts` | `AgentRuntime.stream()` / `RunHandle` / `RunEvent` / `cancel()` |
| `actoviq-file-tools.ts` | `RuntimeTool + ToolRegistry + ToolPolicy`；coding profile 声明 workspace boundary |
| `actoviq-parallel.ts` | read-only tool parallelism 或 `WorkflowGraph` 并行 ready nodes |
| `actoviq-session-manager.ts` | host 管理多个 session id；持久状态由 SQLite session/checkpoint store 承担 |
| `actoviq-checkpoint.ts` | `RunCheckpointStore + SerializedRunState + runtime.resume()` |
| `actoviq-workflow.ts` | `/orchestration` 的 `WorkflowGraph + reducer` |
| `actoviq-workflow-annotated.ts` | 本文 12、14：graph contract + 显式 trusted/untrusted executor |
| `actoviq-workflow-agent-orchestration.ts` | `agentWorkflowNode`、scope inheritance、budget/policy/deadline |
| `actoviq-scheduling.ts` | `DurableAgentScheduler` → `BackgroundChildManager.spawn/query` |
| `actoviq-react-loop.ts` | loop 由 `AgentRuntime` 固定 stage 驱动，tool/middleware 显式注册 |
| `actoviq-computer-use.ts` | compat 工具继续支持；新 runtime 中封装成 side-effect `RuntimeTool` 并由 policy/approval 控制 |
| `actoviq-memory.ts` | `RuntimeServices.memory` + `/node` MemoryStore + opt-in middleware |
| `actoviq-dream.ts` | compat 产品能力保留；新组合使用 memory service + background profile，不新增 dream core 特例 |
| `actoviq-skills.ts` | skills service + opt-in middleware；最小 agent 不扫描 skill 目录 |
| `actoviq-session-memory.ts` | session service 与 memory service 分离，分别版本化/授权 |
| `actoviq-swarm.ts` | `/orchestration` 的 `swarmPreset()`，共享 scope/services |
| `actoviq-platform.ts` | 六类 profile + orchestration primitives 的组合，不创建第二套 runtime |
| `actoviq-workspaces.ts` | `RunOptions.workspaceId` + workspace service/policy；coding profile 默认 containment |
| `actoviq-buddy.ts` | compat 产品能力保留；新组合使用 supervisor profile + as-tool/handoff/spawn |
| `bridge-sdk.ts` | `/surfaces` 的 `AgentRuntimeBridgeAdapter`，包装现有 runtime |
| `bridge-introspection.ts` | `ModelRegistry.list/capabilities` + runtime/service diagnostics |
| `bridge-interactive-agent.ts` | host UI 消费 `SurfaceSemanticEvent`，不拥有 provider/runtime |
| `bridge-sessions.ts` | runtime session service；Bridge adapter 只透传 `RunOptions` |
| `bridge-session-messages.ts` | canonical items + `SqliteRuntimeSessionAdapter.load/append` |

两个 JSON settings example 是 legacy 产品配置示例，不是公共 TypeScript API；迁移时保留在 `/compat` host，或拆为 provider registry、runtime services 与 profile 配置。

## 14. Workflow trust 迁移

旧动态 workflow 不能再省略 trust：

```ts
import {
  LocalIsolatedProcessWorkflowExecutor,
  WorkflowExecutorRouter,
} from 'actoviq-agent-sdk/workflow';

const router = new WorkflowExecutorRouter({
  sandboxExecutor: new LocalIsolatedProcessWorkflowExecutor(),
});

const result = await router.execute({
  trust: 'untrusted',
  workspaceDir: absoluteWorkspace,
  source: '(context) => ({ echoed: context.input })',
  input: { message: 'hello' },
  timeoutMs: 10_000,
});
```

Local process 只降低 ambient access/误操作风险，不是 adversarial multi-tenant sandbox。真正不可信 workload 使用 container/remote `SandboxWorkflowExecutor`。

## 15. Compat diagnostic

```ts
import {
  configureCompatDiagnostics,
  getCompatDiagnostics,
} from 'actoviq-agent-sdk/compat';

configureCompatDiagnostics({
  enabled: true,
  warnOnce: true,
  onDiagnostic(diagnostic) {
    localMetrics.increment(`actoviq.compat.${diagnostic.symbol}`);
  },
});

// 当前只保证 createAgentSdk 被记录。
console.table(getCompatDiagnostics());
```

SDK 不会上传这些数据。Host 若上传/持久化，必须自行获得 consent、redact 并设置 retention。

## 16. 行为对照验收模板

每个迁移用同一 fake provider/tool/session fixture 对照：

| 维度 | 旧基线 | 新结果 | 允许差异 |
|---|---|---|---|
| final text/structured output | 保存 snapshot | 保存 snapshot | 只允许已批准格式变化 |
| model call 数 | count | count | 不得无解释增加 |
| total usage | 所有 call 聚合 | 所有 call 聚合 | provider rounding 可注明 |
| tool call identity/order | call id/name/input | canonical items/events | 并行时只比较定义的偏序 |
| permission decision | allow/deny/ask | policy/interruption | 不得放宽 |
| session messages/revision | JSON v1 | append/CAS | 内容等价，revision 模型可不同 |
| abort/deadline | 完成时间 | 完成时间 | 新边界应更有限，不得无限挂起 |
| event semantics | AgentEvent fixture | RunEvent/view state | UI 最终状态等价 |
| filesystem/network/process | 访问日志 | 访问日志 | 最小/profile 未声明能力应为零 |

## 17. Rollout 与回滚清单

### Rollout

- [ ] 记录旧版本、配置、provider、session 目录、feature flags 和 golden outputs。
- [ ] 先通过 `ModelProviderLegacyAdapter` 迁 provider。
- [ ] 用 fake contract suite 通过 text/stream/tool/structured/usage/abort/unsupported。
- [ ] 迁一个无状态 chat agent，验证零可选 I/O。
- [ ] 每次只增加一种 service/middleware/tool。
- [ ] Session 先 dry-run、备份、shadow read，再 cutover。
- [ ] Event surface 做 dual consume/view-state 对照。
- [ ] 运行 Node 22/24、Windows/Linux；macOS 按 nightly 门禁。
- [ ] `npm pack --dry-run` 验证 subpath 和 optional dependency。
- [ ] 保存 compat diagnostic、错误率、latency、token/cost、conflict/reconciliation 指标。

### 回滚触发条件

- permission/workspace/tenant 边界变宽；
- side-effect 重复或 commit state 不明；
- session item/revision 丢失、CAS 冲突异常升高；
- RunEvent sequence/trace 无法还原；
- provider call/token/cost 无解释增加；
- p95/内存/写放大相对已批准基线回归超过 10%；
- UI/Bridge 关键状态无法呈现；
- Node/OS blocking matrix 失败。

### 回滚顺序

1. 停止新流量和 scheduler/spawn；
2. 等待纯 read run，取消其余 active tree；
3. reconciliation 所有 `started/unknown` side effect；
4. 关闭 runtime/store，避免双 writer；
5. 按 feature flag 从 surface → runtime → provider 逐层回退；
6. Session 回滚按 [JSON → SQLite Runbook](./11-json-v1-to-sqlite-migration-runbook.md)，不要合并双写历史；
7. 保留新 event/checkpoint/SQLite 作为证据，不做临时清理；
8. 重新跑旧 baseline 与数据校验后恢复流量。

## 18. 参考项目与借鉴边界

- [OpenAI Agents SDK 文档](https://openai.github.io/openai-agents-python/)：Agent/Runner 分离、canonical run item、as-tool/handoff、session、HITL、trace 等概念参考；不复制 Python 实现。
- [Agents](https://openai.github.io/openai-agents-python/agents/)、[Running agents](https://openai.github.io/openai-agents-python/running_agents/)、[Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)、[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)、[HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/)、[Sessions](https://openai.github.io/openai-agents-python/sessions/)、[Tracing](https://openai.github.io/openai-agents-python/tracing/)。
- CrewAI：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\crewAI`
- DeerFlow：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
- DeepAgents：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents`
- OpenAI Agents Python：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\openai-agents-python`

参考项目用于比较契约与语义，不成为 Actoviq 的强依赖，也不改变 TypeScript/Node 的 runtime、安全和打包约束。
