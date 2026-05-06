# 07. 工作流编排、并行与会话检查点

这一章介绍编排层：工作流（DAG 多步骤流水线）、并行原语、会话生命周期管理与会话检查点。

## 1. 工作流编排

**工作流**是一个 DAG 步骤图。每个步骤是一次独立的 ReAct 会话。通过 `dependsOn` 连接的步骤构成 DAG——同级步骤并行执行。

### 1.1 基础工作流

```ts
import { createAgentSdk } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk();

const result = await sdk.workflow
  .define('code-review', '自动化代码审查流水线')
  .step('typecheck', '类型检查', '运行类型检查', '对项目运行 tsc --noEmit。')
  .step(
    'lint',
    '代码检查',
    '运行 Linter',
    '运行 ESLint，使用类型检查结果：$steps.typecheck.text',
    { dependsOn: ['typecheck'] },
  )
  .step(
    'report',
    '报告',
    '生成报告',
    '结合类型检查（$steps.typecheck.text）和 lint（$steps.lint.text）结果生成总结报告。',
    { dependsOn: ['typecheck', 'lint'] },
  )
  .run();

console.log(result.status); // 'completed' | 'partial' | 'failed'
for (const step of result.steps) {
  console.log(`${step.id}: ${step.status} (${step.durationMs}ms)`);
}
```

### 1.2 变量插值

工作流在步骤 prompt 中支持两种变量插值：

| 语法 | 含义 | 示例 |
|---|---|---|
| `$steps.<id>.text` | 前一步的文本输出 | `$steps.typecheck.text` |
| `$steps.<id>.toolCalls` | 前一步调用的工具名称 | `$steps.build.toolCalls` |
| `$PARAM_NAME` | 工作流级参数（大写） | `$REPO_PATH`、`$BRANCH` |

### 1.3 工作流参数

```ts
const result = await sdk.workflow
  .define('release-check', '发布前检查清单')
  .param('REPO_PATH', {
    type: 'string',
    description: '仓库路径',
    required: true,
  })
  .param('BRANCH', {
    type: 'string',
    description: '目标分支名称',
    default: 'main',
  })
  .step(
    'checkout',
    '检出',
    '检出目标分支',
    '进入 $REPO_PATH 并切换到分支 $BRANCH。',
  )
  .run({ REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' });
```

### 1.4 单步骤工具限制

限制某个步骤可以使用的工具：

```ts
const result = await sdk.workflow
  .define('safe-read', '只读分析')
  .step(
    'analyze',
    '分析',
    '只读分析',
    '读取并分析项目文件。',
    { allowedTools: ['read', 'glob', 'grep'] },
  )
  .run();
```

### 1.5 单步骤模型

每个步骤可以指定不同模型：

```ts
sdk.workflow
  .define('multi-model', '多模型工作流')
  .step(
    'quick',
    '快速检查',
    '快速初始扫描',
    '快速扫描项目。',
    { model: 'claude-haiku-4-5' },
  )
  .step(
    'deep',
    '深度分析',
    '深入分析',
    '基于 $steps.quick.text 做深度分析。',
    { model: 'claude-sonnet-4-6', dependsOn: ['quick'] },
  )
  .run();
```

### 1.6 工作流事件

通过 `onEvent` 订阅工作流级事件：

```ts
import type { AgentEvent } from 'actoviq-agent-sdk';

const result = await sdk.workflow.run(
  definition,
  params,
  {
    onEvent: (event: AgentEvent) => {
      switch (event.type) {
        case 'workflow.start':
          console.log(`已启动：${event.workflowName}（${event.stepCount} 个步骤）`);
          break;
        case 'step.start':
          console.log(`步骤开始：${event.stepName}`);
          break;
        case 'step.done':
          console.log(`步骤完成：${event.stepId} → ${event.status}（${event.durationMs}ms）`);
          break;
        case 'workflow.done':
          console.log(`工作流完成：${event.workflowName} → ${event.status}`);
          break;
      }
    },
  },
);
```

### 1.7 直接使用 WorkflowEngine

如果 Builder DSL 不够灵活，可以直接使用引擎：

```ts
const result = await sdk.workflow.run({
  name: 'custom-workflow',
  description: '自定义流水线',
  steps: [
    { id: 'a', name: 'A', description: '步骤 A', prompt: '做 A。', dependsOn: [] },
    { id: 'b', name: 'B', description: '步骤 B', prompt: '基于 $steps.a.text，做 B。', dependsOn: ['a'] },
  ],
});
```

### 1.8 错误处理与恢复

每个步骤独立持久化。步骤失败时，可以从其会话恢复：

```ts
const result = await sdk.workflow.run(definition);
const failedStep = result.steps.find(s => s.status === 'failed');
if (failedStep) {
  const session = await sdk.resumeSession(failedStep.sessionId);
  await session.send('上一次尝试失败了，请重新尝试。');
}
```

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
    () => sdk.run('2+2 等于几？', { model: 'claude-haiku-4-5' }),
    () => sdk.run('2+2 等于几？', { model: 'claude-sonnet-4-6' }),
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
npm run example:workflow
npm run example:parallel
npm run example:session-manager
npm run example:checkpoint
```

---

下一章：

- [返回索引](./index.md)
