# 04. Agents、Swarm、Memory 与 Workspace

这一章介绍 clean SDK 里更高层的工作流能力。

## 1. named agents

你可以先定义可复用的角色：

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: '优先报告最尖锐问题的 reviewer。',
      systemPrompt:
        'You are a careful reviewer. Prioritize bugs, regressions, and missing verification.',
    },
  ],
});
```

然后通过这个角色直接运行：

```ts
const result = await sdk.runWithAgent(
  'reviewer',
  '请从发布前检查的角度审查这个仓库。',
);
```

## 2. Task 委派

注册 named agents 之后，clean SDK 就可以通过 `Task` 和相关 helper 把任务交给另一个 agent。

常用入口：

1. `sdk.createTaskTool()`
2. `sdk.runWithAgent(...)`
3. `sdk.createAgentSession(...)`

## 3. swarm teammate 与 side session

如果你想做 leader + teammate 模式，可以用 swarm：

```ts
const team = sdk.swarm.createTeam({
  name: 'release-team',
  leader: 'lead',
  continuous: true,
});
```

常用操作：

1. `spawn(...)`
2. `message(...)`
3. `continueFromMailbox(...)`
4. `reenter(...)`
5. `runBackground(...)`
6. `transcript(...)`
7. `waitForIdle()`

现在还支持 team 级 runtime context：

```ts
team.setRuntimeContext({
  permissions: [{ toolName: 'write_note', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName === 'write_note'
      ? { behavior: 'allow', reason: '允许 teammate 写这次说明。' }
      : { behavior: 'deny', reason: '未预期的工具。' },
});
```

仓库示例：

- [examples/actoviq-swarm.ts](../../examples/actoviq-swarm.ts)

## 4. workspace 管理

SDK 提供了显式的 workspace helper，方便先准备隔离目录，再启动 agent。

可用 helper：

1. `createWorkspace(...)`
2. `createTempWorkspace(...)`
3. `createGitWorktreeWorkspace(...)`

```ts
const workspace = await createTempWorkspace({
  prefix: 'actoviq-demo-',
  copyFrom: './examples',
});

const sdk = await createAgentSdk({
  workDir: workspace.path,
});
```

## 5. memory 与 session memory

SDK 当前提供：

1. relevant memories 选择
2. session-memory prompt / summary helper
3. compact-state 检查
4. 会话足够长时自动 session-memory 提取

主要入口：

```ts
const memory = sdk.memory;
console.log(await memory.findRelevantMemories('发布这个包之前应该注意什么？'));
```

在 session 级别：

```ts
const extraction = await session.extractMemory();
const state = await session.compactState({
  includeSessionMemory: true,
  includeSummaryMessage: true,
});
```

仓库示例：

- [examples/actoviq-memory.ts](../../examples/actoviq-memory.ts)
- [examples/actoviq-session-memory.ts](../../examples/actoviq-session-memory.ts)

## 6. compact

clean SDK 当前支持：

1. 自动 compact
2. reactive compact
3. API-oriented microcompact shaping
4. compact history 和 continuity metadata 持久化

它最重要的价值是在长对话和多轮任务里控制上下文长度，同时尽量保留连续性。

下一章：

- [05-bridge-runtime.md](./05-bridge-runtime.md)
