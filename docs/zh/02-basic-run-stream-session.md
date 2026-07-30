# 02. 基础调用：run、stream、session

这一章讲最常用的三种调用方式：

1. 单次调用 `run(...)`
2. 流式调用 `stream(...)`
3. 多轮对话 `session`

前 13 节使用 `createAgentSdk()` 交互/兼容入口；最后一节说明模块化 `AgentRuntime` 的对应 contract。

## 1. `createAgentSdk()`

Hadamard SDK 的入口是：

```ts
import { createAgentSdk } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk();
```

常见可传选项包括：

1. `workDir`
2. `tools`
3. `mcpServers`
4. `agents`
5. `skills`
6. `permissionMode`
7. `permissions`

## 2. 单次调用 `run(...)`

当你只想完成一次任务，不需要保留上下文时，用 `run(...)`：

```ts
const result = await sdk.run('请用一段话说明这个 SDK 是做什么的。');
console.log(result.text);
console.log(result.toolCalls);
```

## 3. 流式调用 `stream(...)`

如果你想边生成边输出，用 `stream(...)`：

```ts
const stream = sdk.stream('请解释一下 session 是什么。');

for await (const event of stream) {
  if (event.type === 'response.text.delta') {
    process.stdout.write(event.delta);
  }
}

const result = await stream.result;
console.log('\nfinal:', result.text);
```

## 4. 多轮会话 `session`

如果你希望模型记住前面对话，就要创建 session：

```ts
const session = await sdk.createSession({ title: 'Demo Session' });

await session.send('记住发布代号是 Sparrow');
const reply = await session.send('发布代号是什么？');

console.log(session.id);
console.log(reply.text);
```

## 5. 每个 session 的 ID 在哪里看？

你可以从这几个地方看到：

1. `session.id`
2. `result.sessionId`
3. `sdk.sessions.list()`

示例：

```ts
const session = await sdk.createSession({ title: 'My Session' });
console.log(session.id);

const sessions = await sdk.sessions.list();
console.log(sessions);
```

## 6. 历史对话保存在哪里？

Hadamard SDK 的 session 历史是本地文件存储。

默认目录：

```text
~/.actoviq/projects/<workspace-key>
```

其中 `<workspace-key>` 由规范化工作目录生成。旧版全局目录中的可归属数据会在首次解析项目目录时尝试迁移。里面保存的内容通常包括：

1. session ID
2. 标题
3. tags
4. metadata
5. messages
6. run history
7. 时间戳

## 7. 这个保存位置可以修改吗？

可以。创建 SDK 时传 `sessionDirectory`：

```ts
const sdk = await createAgentSdk({
  sessionDirectory: 'E:/my-session-store',
});
```

这样 Hadamard SDK 的 session 文件就会写到你指定的位置。

## 8. session ID 可以自定义吗？

可以，在创建时传入 `id`：

```ts
const session = await sdk.createSession({
  id: 'release-planning-2026',
  title: 'Release Planning',
});
```

ID 必须满足安全存储段约束，而且不能与现有 session 冲突；不传时由 SDK 自动生成。你还可以自定义：

1. `title`
2. `tags`
3. `metadata`
4. `sessionDirectory`

## 9. 怎么查看历史 session 并恢复？

```ts
const sessions = await sdk.sessions.list();
console.log(sessions);

const restored = await sdk.resumeSession('your-session-id');
const reply = await restored.send('继续刚才的话题。');
console.log(reply.text);
```

恢复会话时会同时恢复对话记录、compact 元数据、当前模型以及持久化的权限模式与规则。也可以继续最近会话，或创建不修改原会话的分支：

```ts
const latest = await sdk.sessions.continueMostRecent();
const fork = await sdk.sessions.resume(latest.id, {
  fork: true,
  model: 'max',
  permissionMode: 'default',
});
```

## 10. 一个完整的 session 管理示例

```ts
const sdk = await createAgentSdk();

const session = await sdk.createSession({
  title: 'Release Planning',
  tags: ['release', 'ci'],
  metadata: { owner: 'team-a' },
});

await session.send('记住发布步骤里必须先运行 npm pack --dry-run。');

console.log('current id:', session.id);
console.log('stored sessions:', await sdk.sessions.list());

const restored = await sdk.resumeSession(session.id);
console.log((await restored.send('发布步骤里必须包含什么？')).text);
```

## 11. GUI 的 Session Center 与项目多工作路径

GUI 的 Project → Chats 是统一 Session Center。它只读取 Workspace Registry 中登记的项目和 Global Assistant 目录，不扫描数据目录中的全部历史哈希：

- 默认显示普通用户对话；按类型可查看 Global Assistant、Project Manager 和只读的 Agent 子会话。
- 支持项目、运行状态、归档状态和关键词筛选，每页按需加载。
- 排序优先级是运行/等待中、置顶、最近更新。
- 普通对话和 Assistant Session 可以新建、打开、重命名、置顶、归档、恢复；永久删除只对已归档且未运行的 Session 开放。
- Agent 子会话由 Agent Monitor 管理，Session Center 不单独归档或删除它们。

一个逻辑项目可以登记一个主路径和多个附加工作路径。项目会话的存储 locator 始终使用主路径，因此切换到附加路径不会生成第二个“同名项目”；新 turn 会记录当时的活动工作路径。操作步骤：

1. 打开项目详情。
2. 点击顶部 `+ Work path`，选择已经存在的目录。
3. 用路径下拉框切换当前路径。
4. 若要移除附加路径，先切回主路径，再确认移除。该操作只修改 Registry，不删除源文件。

旧版单路径 Registry 会被当作只含主路径的项目读取，无需批量迁移。

## 12. 并行运行任务

用 `sdk.parallel()` 并发运行独立任务：

```ts
const results = await sdk.parallel([
  () => sdk.run('用一句话总结项目。'),
  () => sdk.run('列出待办事项。'),
], { maxConcurrency: 2 });
```

用 `sdk.race()` 返回最先完成的结果：

```ts
const fastest = await sdk.race([
  () => sdk.run('快速回答', { model: 'min' }),
  () => sdk.run('详细回答', { model: 'medium' }),
]);
```

## 13. 会话生命周期

配置 `sessionManager` 自动管理空闲超时和会话上限：

```ts
const sdk = await createAgentSdk({
  sessionManager: { idleTimeoutMs: 30 * 60_000, maxSessions: 100 },
});

// 查看统计或清理旧会话
const stats = await sdk.sessions.stats();
await sdk.sessions.prune({ status: 'idle', olderThan: '1h' });
```

## 14. 会话检查点

检查点分两层：

- `session.saveCheckpoint()` 保存对话快照。
- Hadamard 文件检查点会记录 `Write`、`Edit`、`NotebookEdit` 产生的文件变化，可预览后选择恢复 `files`、`conversation` 或 `both`。

GUI/TUI 的恢复操作都要求显式确认；文件已被外部修改时会报告冲突，不会静默覆盖。Bash 或第三方工具绕过 Hadamard 文件工具产生的修改不会被伪装成已捕获。

## 15. Session 分支、自动 Worktree 与编辑器

Session 支持树状 lineage、从稳定消息节点 fork/clone，以及非活动分支摘要。交互面使用：

```text
/session tree
/session fork <message-id>
/session clone <message-id>
/session label <name>
```

启用 `autoWorktree` 后，新建主 Session 会获得独立的 Git worktree；任务修改可在 Diff Review 中预览并确认应用。一个 Session 的分支关系与 Git 分支不是同一概念：前者保存对话 lineage，后者隔离文件变更。

仓库还提供 transport-neutral app-server 和轻量 VS Code/Cursor 扩展。编辑器通过相同的 Session、Goal、审批、Diff 和 Checkpoint contract 工作，不需要把 GUI 页面嵌入 IDE。

所有编排功能的完整文档见第 07 章。

## 16. 模块化 Runtime 的 run、stream 与 session

`AgentRuntime` 不创建一个带方法的 session 对象。它通过 `RunOptions` 接收稳定的 `tenantId`、`sessionId` 与可选 revision，并通过 `RuntimeServices` 中的 `sessions` service 读写历史：

```ts
import type { AgentSpec } from 'actoviq-agent-sdk/core';
import {
  ModelRegistry,
  OpenAIResponsesProvider,
} from 'actoviq-agent-sdk/providers';
import {
  AgentRuntime,
  RuntimeServices,
} from 'actoviq-agent-sdk/runtime';
import {
  SqliteRuntimeSessionAdapter,
  SqliteStorageV2,
} from 'actoviq-agent-sdk/node';

const storage = await SqliteStorageV2.open({
  filename: './data/agent.sqlite',
});

const runtime = new AgentRuntime({
  models: new ModelRegistry([
    new OpenAIResponsesProvider({
      apiKey: process.env.OPENAI_API_KEY,
    }),
  ]),
  defaultModel: {
    provider: 'openai-responses',
    model: 'gpt-4.1-mini',
  },
  services: new RuntimeServices({
    sessions: {
      factory: () => new SqliteRuntimeSessionAdapter({
        store: storage.sessions,
      }),
    },
  }),
});

const agent: AgentSpec = {
  id: 'chat',
  name: 'Chat',
  instructions: 'Answer briefly.',
};

try {
  await runtime.run(agent, '记住发布代号是 Sparrow。', {
    tenantId: 'local-user',
    sessionId: 'release-chat',
  });
  const result = await runtime.run(agent, '发布代号是什么？', {
    tenantId: 'local-user',
    sessionId: 'release-chat',
  });
  console.log(result.output);
} finally {
  await runtime.close();
  await storage.close();
}
```

重要差异：

- 传了 `sessionId` 却没有注册 `sessions` service，会明确失败，不会静默退化成内存会话。
- 同一 tenant/session 的并发 turn 会串行化；不同 session 仍受 runtime 全局并发上限控制。
- `runtime.stream(...)` 返回 `RunHandle`。它既是 `AsyncIterable<RunEvent>`，也提供 `result`、`cancel()` 和 `snapshot()`。
- interruption/checkpoint 是 run-state contract；`createAgentSdk()` 的 `session.saveCheckpoint()` 是更高层的会话便利 API，两者不要混为同一存储格式。

下一章：

- [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
