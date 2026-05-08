# 07. 工作流编排、并行与会话检查点

这一章介绍编排层：工作流（DAG 多步骤流水线）、并行原语、会话生命周期管理与会话检查点。

## 1. 工作流编排

**工作流**是一个 DAG 步骤图。每个步骤是一次独立的 ReAct 会话。通过 `dependsOn` 连接的步骤构成 DAG——同级步骤并行执行。

### 1.0 API 参考

`sdk.workflow` 提供两种设计路径：**Builder DSL** 面向人类编写的 TypeScript 代码，**直接 JSON 定义** 面向 Agent 或机器生成的工作流。两种路径最终调用同一个 `WorkflowEngine.run()`，产生相同结果。

#### Builder DSL

入口是 `sdk.workflow.define(name, description)`，返回 `WorkflowBuilder`，所有方法均支持链式调用。

**`define(name: string, description?: string): WorkflowBuilder`**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 工作流唯一标识，用于日志、事件和会话标题。 |
| `description` | `string` | 否 | 工作流用途描述，写入会话元数据。 |

**`param(name: string, definition: WorkflowParameter): this`**

定义一个工作流级参数，可在步骤 prompt 中通过 `$PARAM_NAME`（大写）引用。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 参数名，在 prompt 中用 `$NAME` 引用（需全大写）。 |
| `definition.type` | `'string' \| 'number' \| 'boolean' \| 'json'` | 是 | 参数类型。 |
| `definition.description` | `string` | 是 | 参数说明。 |
| `definition.required` | `boolean` | 否 | 是否必填，默认 `false`。 |
| `definition.default` | `unknown` | 否 | 默认值，调用 `.run()` 未传时使用。 |

**`model(model: string | null): this`**

设置所有步骤的默认模型。单个步骤可通过 `step()` 的 `opts.model` 覆盖。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | `string \| null` | 否 | 模型 ID，如 `'claude-medium-4-6'`。传 `null` 清除全局设置。 |

**`systemPrompt(prompt: string): this`**

设置所有步骤的默认系统提示词。单个步骤可通过 `step()` 的 `opts.systemPrompt` 覆盖。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | `string` | 否 | 系统级提示词文本。 |

**`step(id, description, prompt, opts?): this`**

添加一个工作流步骤。这是最核心的方法。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 步骤唯一标识。用于 `dependsOn` 引用和 `$steps.<id>.text` 变量插值。 |
| `description` | `string` | 是 | 人类可读的显示名称。用于日志、事件（`event.stepName`）、会话标题和结果查找。可以为空字符串 `''`。 |
| `prompt` | `string` | 是 | 步骤提示词。支持 `$steps.<id>.text`、`$steps.<id>.toolCalls` 和 `$PARAM_NAME` 三种变量插值。 |
| `opts.dependsOn` | `string[]` | 否 | 依赖的步骤 ID 列表。不在此列表中的同层步骤会并行执行。 |
| `opts.allowedTools` | `string[]` | 否 | 限制此步骤可用的工具名称列表，如 `['read', 'grep']`。 |
| `opts.tools` | `(string \| AgentToolDefinition)[]` | 否 | 此步骤专属的额外工具定义。字符串在运行时通过 SDK 工具注册表解析。 |
| `opts.mcpServers` | `AgentMcpServerDefinition[]` | 否 | 此步骤专用的 MCP 服务器列表。 |
| `opts.skillDirectories` | `string[]` | 否 | 此步骤额外加载的 skill 目录（与全局 skills 合并）。 |
| `opts.model` | `string \| null` | 否 | 覆盖此步骤的模型，优先级高于全局 `model()`。 |
| `opts.systemPrompt` | `string` | 否 | 覆盖此步骤的系统提示词，优先级高于全局 `systemPrompt()`。 |
| `opts.mode` | `'react' \| 'single'` | 否 | 运行模式。`'react'`（默认）= 完整工具调用 ReAct 循环。`'single'` = 单次回答，不调用工具。 |

**`run(params?, options?): Promise<WorkflowRunResult>`**

执行工作流，返回结果。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `params` | `Record<string, unknown>` | 否 | 工作流参数键值对，对应 `.param()` 定义。 |
| `options.onEvent` | `(event: AgentEvent) => void` | 否 | 事件回调，接收 `workflow.start`、`step.start`、`step.done`、`workflow.done` 四种事件。 |
| `options.signal` | `AbortSignal` | 否 | 用于取消整个工作流。 |

#### 直接使用引擎

**`sdk.workflow.run(definition, params?, options?): Promise<WorkflowRunResult>`**

跳过 Builder DSL，直接传入 `WorkflowDefinition` 对象。`definition` 结构：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 工作流名称。 |
| `description` | `string` | 是 | 工作流描述。 |
| `steps` | `WorkflowStepDefinition[]` | 是 | 步骤数组，每个步骤包含 `id`、`description`、`prompt`、`dependsOn`、`tools`、`mode` 等字段。 |
| `parameters` | `Record<string, WorkflowParameter>` | 否 | 参数定义。 |
| `model` | `string \| null` | 否 | 全局模型。 |
| `systemPrompt` | `string` | 否 | 全局系统提示词。 |

#### 两种设计路径

Builder DSL 和直接 JSON 定义服务于不同的作者，同一个引擎：

| | Builder DSL | 直接 JSON |
|---|---|---|
| **作者** | 人类开发者 | Agent（LLM 输出）或偏好原始 JSON 的用户 |
| **类型安全** | 编译期（自动补全、重构、拼错步骤 ID 时报错） | 仅运行时 |
| **集成方式** | `sdk.workflow.define(...).step(...).run()` 链式调用 | `sdk.workflow.run(definition, params, opts)` 一次调用 |
| **可序列化** | 编译为 `WorkflowDefinition`（与 JSON 相同结构） | 本身就是 JSON |

两种路径最终都汇聚到 `WorkflowEngine.run()`。引擎处理的是同一个 `WorkflowDefinition` 类型，无论它来自哪里。

#### 部署模式

工作流可以在两种上下文中运行：

**独立运行** — 用户代码显式调用：

```ts
// Builder
const result = await sdk.workflow.define('release-check', '...')
  .step('lint', '运行 Lint', '...').run()

// JSON
const result = await sdk.workflow.run(
  { name: 'release-check', steps: [...] },
  { REPO_PATH: '/home/user/project' },
)
```

**嵌入 Subagent** — 工作流定义作为 Agent 定义的一部分加载，由主 Agent 通过工具调用或 skill 触发：

```ts
const sdk = await createAgentSdk({
  agents: [{
    name: 'release-bot',
    description: '自动化发布检查流水线',
    // Subagent 内部可以调用 sdk.workflow.run()
  }],
})
```

两种模式下，每个步骤都创建独立会话。无论哪种上下文启动，步骤都可以通过 `resumeSession(step.sessionId)` 单独恢复重试。

#### 返回值 `WorkflowRunResult`

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | `string` | 本次运行的唯一 ID。 |
| `workflowName` | `string` | 工作流名称。 |
| `steps` | `WorkflowStepResult[]` | 所有步骤的执行结果数组。 |
| `text` | `string` | 最后一个成功步骤的文本输出。 |
| `durationMs` | `number` | 工作流总耗时（毫秒）。 |
| `status` | `'completed' \| 'partial' \| 'failed'` | 最终状态：全部成功 / 部分成功 / 全部失败。 |

`WorkflowStepResult` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 步骤 ID。 |
| `name` | `string` | 步骤名称。 |
| `status` | `'completed' \| 'failed' \| 'skipped'` | 步骤状态。依赖步骤失败时后续步骤标记为 `skipped`。 |
| `text` | `string` | 步骤的文本输出。 |
| `toolCalls` | `string[]` | 步骤调用的工具名称列表。 |
| `durationMs` | `number` | 步骤耗时（毫秒）。 |
| `sessionId` | `string` | 步骤对应的会话 ID，可用于 `resumeSession()` 恢复。 |
| `error` | `string?` | 失败时的错误信息。 |

### 1.1 逐行讲解 — 配合完整示例

以下配合 `examples/workflow-annotated.ts` 中的一个完整场景，逐步解释每个参数传什么、为什么这样传、数据流向哪里。

**场景：对指定的 Git 仓库做发布前检查。**要求：仓库路径和分支名由调用者传入、第一步只读、第二步依赖第一步、第三步用更快模型汇总。

> 运行示例：`npm run example:workflow-annotated`

---

**第一步：`sdk.workflow.define(name, description)` — 创建工作流**

```ts
.define('release-check', '对指定仓库执行发布前类型检查和 lint')
```

两个参数都很简单：

- `name` = `'release-check'` — 这个字符串会出现在三个地方：事件回调的 `event.workflowName`、每个步骤的会话标题（格式为 `"release-check/类型检查"`）、返回结果 `result.workflowName`。**取一个见名知意的英文 ID 即可。**
- `description` — 纯文档用途，写入会话元数据，不影响执行。

---

**第二步：`.param(name, definition)` — 定义外部参数**

```ts
.param('REPO_PATH', {
  type: 'string',
  description: '要检查的仓库本地路径',
  required: true,
})
.param('BRANCH', {
  type: 'string',
  description: '要检查的分支名',
  default: 'main',
})
```

**为什么需要 param？**如果不用参数，仓库路径就得硬编码在 prompt 里，工作流无法复用。定义参数后，同一个工作流可以传入不同路径执行。

逐个字段说明：

- `name` = `'REPO_PATH'` — 在步骤 prompt 中通过 `$REPO_PATH` 引用。**必须全大写**，这是变量替换的识别规则（`$` 后跟大写字母才会触发替换）。
- `definition.type` = `'string'` — 告诉系统这个参数是字符串。可选值：`string` / `number` / `boolean` / `json`。
- `definition.description` — 仅用于文档可读性。
- `definition.required` = `true` — 调用 `.run()` 时不传 `REPO_PATH` 会直接报错。因为这个参数没有默认值，不传就无法工作。
- `definition.default` — `BRANCH` 的默认值是 `'main'`。调用者如果不传分支名，自动检查 main 分支。

---

**第三步：`.model(model)` 和 `.systemPrompt(prompt)` — 全局兜底**

```ts
.model('claude-medium-4-6')
.systemPrompt('你是一个 DevOps 工程师。只报告检查结果，不闲聊。语言：中文。')
```

这两个方法是**全局默认值**——所有步骤自动继承，但单个步骤可以通过 `opts.model` / `opts.systemPrompt` 覆盖。

- `model` — 大部分步骤用同一个模型时，在这里设一次即可。个别需要不同模型的步骤再单独覆盖（见下文 report 步骤）。
- `systemPrompt` — 适合放所有步骤都需要的背景约束，比如角色设定、输出语言、格式要求。

---

**第四步：`.step(id, description, prompt, opts?)` — 核心：添加步骤**

这是最核心的方法，每调用一次就向工作流添加一个步骤。下面通过三个步骤逐一说明。

**步骤 1：typecheck（类型检查）**

```ts
.step(
  'typecheck',       // ① id
  '类型检查',         // ② description — 显示名称，出现在 event.stepName 和会话标题中
  '对位于 $REPO_PATH 的仓库执行 tsc --noEmit，检查 $BRANCH 分支是否有类型错误。',  // ③ prompt
  { allowedTools: ['read', 'glob', 'grep'] },  // ④ opts
)
```

逐参数说明：

- ① **`id` = `'typecheck'`** — 步骤的唯一标识。**三个关键用途：**
  - 其他步骤用 `dependsOn: ['typecheck']` 声明依赖它
  - 后续步骤用 `$steps.typecheck.text` 读取它的输出文本
  - 返回结果中用 `result.steps.find(s => s.id === 'typecheck')` 查找它
  - **取名建议：简短英文，只用小写字母和连字符。**

- ② **`description` = `'类型检查'`** — 显示名称，面向人类。出现在事件回调 `event.stepName` 和会话标题（格式：`"release-check/类型检查"`）中。可以包含中文和空格。

- ③ **`prompt`** — **这是真正决定步骤做什么的字符串。**发送给 AI 模型的就是它。注意 `$REPO_PATH` 和 `$BRANCH` 会在执行时被替换为 `.run()` 传入的实际值。

- ④ **`opts.allowedTools`** — 限制本步骤只能使用 `read`、`glob`、`grep` 三种工具。类型检查是只读操作，不应允许写文件或执行命令。**这里没传 `dependsOn`，默认 `[]`，表示不依赖任何步骤，可以立即执行。**

**步骤 2：lint（代码检查）**

```ts
.step(
  'lint',
  '代码检查',
  '对 $REPO_PATH 的 $BRANCH 分支运行 ESLint。类型检查结果：$steps.typecheck.text',
  { dependsOn: ['typecheck'] },  // ← 关键：声明依赖
)
```

与步骤 1 的关键区别：

- **`prompt` 中多了 `$steps.typecheck.text`** — 这会被替换为步骤 typecheck 的实际输出文本。这样 lint 步骤就能"看到"类型检查的结果。
- **`opts.dependsOn: ['typecheck']`** — **声明执行顺序依赖。**这意味着：
  1. typecheck 完成后才执行 lint
  2. typecheck 失败时 lint 自动跳过
  3. `$steps.typecheck.text` 只有在 typecheck 成功时才有有效值
- **没传 `allowedTools`** — 不限制，继承 SDK 默认权限。
- **没传 `model`** — 自动使用全局 `.model('claude-medium-4-6')`。

**步骤 3：report（生成报告）**

```ts
.step(
  'report',
  '生成报告',
  '请根据以下信息生成 $BRANCH 分支的发布前检查报告：\n'
    + '类型检查：$steps.typecheck.text\n'
    + 'Lint 检查：$steps.lint.text',
  {
    dependsOn: ['typecheck', 'lint'],  // 依赖两个步骤
    model: 'claude-min-4-5',          // 覆盖全局模型
    systemPrompt: '你是一个技术报告生成器。只输出 markdown 格式的报告，不要对话。',
    mode: 'single',                     // 单次回答，报告生成不需要工具调用
  },
)
```

与前两步的区别：

- **`dependsOn: ['typecheck', 'lint']`** — 同时依赖两个步骤。引擎会等待两者都完成（lint 又依赖 typecheck，所以实际执行顺序是 typecheck → lint → report）。**同层步骤并行——如果还有另一个步骤也只依赖 typecheck，它会和 lint 同时执行。**
- **`model: 'claude-min-4-5'`** — 覆盖全局模型。报告汇总不需要深度推理，用更快的模型节省时间和成本。
- **`systemPrompt`** — 覆盖全局系统提示词。报告步骤需要 markdown 格式输出，与前两步的"DevOps 工程师"角色要求不同。
- **`mode: 'single'`** — 报告步骤只生成文本，不需要工具。`'single'` 模式设置 `toolChoice: { type: 'none' }`，直接返回单次回答而不进入 ReAct 工具循环。默认是 `'react'`。

---

**第五步：`.run(params, options?)` — 触发执行**

```ts
.run(
  { REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' },
  {
    onEvent: (event: AgentEvent) => {
      switch (event.type) {
        case 'workflow.start': /* ... */ break;
        case 'step.start':    /* ... */ break;
        case 'step.done':     /* ... */ break;
        case 'workflow.done': /* ... */ break;
      }
    },
  },
)
```

`.run()` 之前的所有调用都只是**声明**工作流结构。调用 `.run()` 才真正开始执行。

- **第一个参数 `params`** — 传给 `.param()` 定义的参数。`REPO_PATH` 是必传的，`BRANCH` 可省略（有默认值 `'main'`）。这些值会被注入到各步骤 prompt 中的 `$REPO_PATH` 和 `$BRANCH` 位置。
- **第二个参数 `options.onEvent`** — 事件回调。工作流执行过程中会触发 4 种事件，可以在回调中做进度展示、日志记录等。回调不影响执行结果，纯旁路监听。

---

**执行结果 `result` 解读：**

```ts
result.status       // 'completed' | 'partial' | 'failed'
result.steps        // 所有步骤的结果数组，顺序与定义一致
result.text         // 最后一个成功步骤的文本输出（此处为 report 步骤）
result.durationMs   // 工作流总耗时
```

每个 `step` 对象：

```ts
step.id          // 'typecheck' | 'lint' | 'report'
step.name        // '类型检查' | '代码检查' | '生成报告'（即 description 字段）
step.status      // 'completed' | 'failed' | 'skipped'
step.text        // 该步骤 AI 输出的文本
step.toolCalls   // 该步骤调用的工具名称列表
step.durationMs  // 该步骤耗时
step.sessionId   // 会话 ID — 失败时用 resumeSession() 恢复重试
step.error       // 失败原因（仅 status === 'failed' 时有值）
```

**失败恢复：**

```ts
const failed = result.steps.find(s => s.status === 'failed');
if (failed) {
  const session = await sdk.resumeSession(failed.sessionId);
  await session.send('上一次执行失败了，请重试。');
}
```

每个步骤独立持久化。失败时从其 `sessionId` 恢复会话重试，不影响其他已成功的步骤。

### 1.2 Agent 自主编排工作流

除了手动编写 Builder 脚本，你也可以让 Agent 自主设计并执行工作流。Agent 接收高层级任务后，生成 `WorkflowDefinition` JSON，通过自定义工具提交执行。

**工作原理：**

1. 使用 `tool()` 辅助函数和 Zod schema 定义 `run_workflow` 自定义工具
2. 工具闭包捕获 SDK 实例
3. Agent 调用 `run_workflow` 并传入 JSON 工作流定义
4. 工具内部调用 `sdk.workflow.run()` 并返回格式化结果

这种模式连接了两种设计路径：Agent 编写 JSON，引擎执行——与人类编写的 JSON 工作流走完全相同的执行路径。

**运行示例：**

```bash
npm run example:workflow-agent-orchestration
```

**核心代码 — 创建 `run_workflow` 工具：**

```ts
import { tool, z } from 'actoviq-agent-sdk';

function createRunWorkflowTool(sdk) {
  return tool(
    {
      name: 'run_workflow',
      description: '从 JSON 定义执行多步骤工作流...',
      inputSchema: z.object({
        definition: z.record(z.string(), z.unknown())
          .describe('完整的 WorkflowDefinition 对象。'),
        params: z.record(z.string(), z.string()).optional()
          .describe('工作流参数，键值对形式。'),
      }),
    },
    async (input) => {
      const definition = input.definition;
      const params = input.params ?? {};
      return await sdk.workflow.run(definition, params, { onEvent });
    },
  );
}
```

**Agent 会话设置：**

```ts
const sdk = await createAgentSdk({ workDir: process.cwd() });
const runWorkflowTool = createRunWorkflowTool(sdk);

const session = await sdk.createSession({
  title: '工作流编排器',
  systemPrompt: '设计工作流 JSON 并调用 run_workflow，只需调用一次。',
});

await session.send(taskPrompt, {
  tools: [runWorkflowTool],
  permissionMode: 'bypassPermissions',  // 允许 Agent 调用自定义工具
});
```

**变量插值同样可用** — 步骤 prompt 中的 `$steps.<id>.text` 和 `$steps.<id>.toolCalls` 会自动从前序步骤输出中解析。

这种模式在以下场景特别强大：
- 任务动态变化（Agent 先检查仓库再设计步骤）
- 构建能委托子工作流的元 Agent
- 让最终用户用自然语言而非代码描述任务

完整可运行示例见 [`examples/workflow-agent-orchestration.ts`](https://github.com/DeconBear/actoviq-agent-sdk/blob/main/examples/workflow-agent-orchestration.ts)。

---

## 2. 并行原语

`parallel()` 和 `race()` 独立于工作流——任何并发任务都可以使用。

### 2.1 `parallel()`

并发运行多个任务，可配置并发数：

```ts
const results = await sdk.parallel(
  [
    () => sdk.run('用一句话总结项目。'),
    () => sdk.run('列出代码库中的前三个待办事项。'),
    () => sdk.run('审查代码结构中的潜在问题。'),
  ],
  { maxConcurrency: 3 },
);

console.log(results[0]?.text);
console.log(results[1]?.text);
console.log(results[2]?.text);
```

选项：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `maxConcurrency` | `5` | 同时运行的最大任务数 |
| `failFast` | `false` | 第一个失败时停止所有任务 |
| `signal` | — | 用于取消执行的 `AbortSignal` |

### 2.2 `race()`

运行多个任务，返回最先完成的：

```ts
const fastest = await sdk.race(
  [
    () => sdk.run('2+2 等于几？', { model: 'claude-min-4-5' }),
    () => sdk.run('2+2 等于几？', { model: 'claude-medium-4-6' }),
  ],
  { timeoutMs: 30_000 },
);

console.log(fastest.text);
```

选项：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `timeoutMs` | — | 最大等待时间，超时抛错 |
| `signal` | — | 用于取消执行的 `AbortSignal` |

---

## 3. 会话生命周期管理

`SessionManager` 提供会话生命周期管理：空闲超时、清理和统计。

### 3.1 配置

```ts
const sdk = await createAgentSdk({
  sessionManager: {
    idleTimeoutMs: 30 * 60_000,    // 30 分钟后标记为空闲（默认）
    maxSessions: 100,               // 最大存储会话数
    maxConcurrentActive: 10,        // 最大并发活跃会话数
    cleanupIntervalMs: 5 * 60_000,  // 自动清理间隔（默认 5 分钟）
  },
});
```

### 3.2 会话状态

| 状态 | 含义 |
|---|---|
| `active` | 会话最近被使用（通过 `send`/`stream` 接触） |
| `idle` | 超过 `idleTimeoutMs` 未被使用 |
| `closed` | 通过 `closeIdle()` 显式关闭 |

### 3.3 管理会话

```ts
// 获取会话统计
const stats = await sdk.sessions.stats();
console.log(stats); // { total, active, idle, closed }

// 清理 7 天前的已关闭会话
await sdk.sessions.prune({ status: 'closed', olderThan: '7d' });

// 清理 1 小时前的空闲会话
await sdk.sessions.prune({ status: 'idle', olderThan: '1h' });

// 关闭所有空闲会话
const closed = await sdk.sessions.closeIdle();
console.log(`已关闭 ${closed} 个会话`);
```

### 3.4 `touch()` 如何工作

每次 `session.send()` 调用会自动 touch 会话，重置其空闲计时器并更新 `lastActiveAt`。无需手动调用。

---

## 4. 会话检查点

检查点让你可以保存和恢复会话状态——适用于风险重构前的快照或探索替代方案。

### 4.1 保存与恢复

```ts
const session = await sdk.createSession({ title: '检查点演示' });

await session.send('记住：API 运行在 8080 端口。');
await session.send('数据库结构在 db/schema.sql 中。');

// 保存检查点
const cp = await session.saveCheckpoint('重构前');
console.log(`检查点：${cp.id}`);

// 做一些有风险的操作
await session.send('将所有 API 端点从 /api 重命名为 /v2。');

// 算了，恢复
await session.restoreCheckpoint(cp.id);

// 验证——重命名的对话已消失
const reply = await session.send('API 运行在哪个端口？');
console.log(reply.text); // 包含 "8080"
```

### 4.2 多个检查点

```ts
// 保存基线
const baseline = await session.saveCheckpoint('基线');

// 尝试方案 A
await session.send('写一个 class-based React 组件。');
const approachA = await session.saveCheckpoint('方案-a');

// 回退，尝试方案 B
await session.restoreCheckpoint(baseline.id);
await session.send('写一个 hooks-based React 组件。');
const approachB = await session.saveCheckpoint('方案-b');
```

### 4.3 管理检查点

```ts
// 列出会话的所有检查点
const checkpoints = await session.listCheckpoints();
for (const cp of checkpoints) {
  console.log(`${cp.id} | "${cp.label}" | ${cp.createdAt}`);
}

// 删除检查点
await session.deleteCheckpoint('checkpoint-id');
```

---

## 5. 完整示例

运行以下示例查看所有功能的实际运行效果：

```bash
npm run example:workflow-annotated  # 逐参数注释的完整工作流示例（推荐先看这个）
npm run example:workflow            # 工作流基础示例
npm run example:parallel            # 并行和竞速原语
npm run example:session-manager     # 会话生命周期管理
npm run example:checkpoint          # 会话检查点
```

---

下一章：

- [返回索引](./index.md)
