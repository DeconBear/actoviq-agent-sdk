# 04. Agents、Swarm、Memory 与 Workspace

这一章介绍 clean SDK 里更高层的工作流能力，也就是“让 agent 更像一个长期协作系统”的那部分。

## 1. named agents

你可以先注册可复用的角色：

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: '优先报告最尖锐问题的 reviewer',
      systemPrompt:
        'You are a careful reviewer. Prioritize bugs, regressions, and missing verification.',
    },
  ],
});
```

然后直接通过这个角色运行：

```ts
const result = await sdk.runWithAgent(
  'reviewer',
  '请从发布前检查的角度审查这个仓库。',
);
```

## 2. Task 委派

如果你注册了 named agents，clean SDK 就能通过 `Task` 把子任务委派给另一个 agent。

常用入口：

1. `sdk.createTaskTool()`
2. `sdk.runWithAgent(...)`
3. `sdk.createAgentSession(...)`

这适合做：

1. reviewer 子流程
2. release-check 子流程
3. 某个专门 agent 的后台调查任务

## 3. Swarm、teammate 和 side session

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

你还可以给整个 team 设置运行时权限：

```ts
team.setRuntimeContext({
  permissions: [{ toolName: 'write_note', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName === 'write_note'
      ? { behavior: 'allow', reason: '允许 teammate 写说明。' }
      : { behavior: 'deny', reason: '未预期的工具。' },
});
```

仓库示例：

- [examples/actoviq-swarm.ts](../../examples/actoviq-swarm.ts)

## 4. Workspace 管理

如果你想让 agent 在独立目录里工作，可以先准备 workspace，再启动 SDK：

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

## 5. Memory、session-memory 和 relevant memories

clean SDK 当前已经提供：

1. relevant memories 选择
2. session-memory prompt / summary helper
3. compact-state 检查
4. 会话足够长时自动提取 session-memory

主入口：

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

## 6. Dream：长期记忆整合

Dream 可以理解成一次“对最近若干会话的记忆整理”。

### 查看当前 dream 状态

```ts
const state = await sdk.dreamState();
console.log(state);
```

### 手动运行 dream

```ts
const session = await sdk.createSession({ title: 'Dream Demo' });
const result = await session.dream({
  extraContext: '把最近关于发布流程、稳定配置和工作方式的结论整理进长期记忆。',
});

console.log(result.result?.text);
console.log(result.touchedFiles);
```

### 触发自动 dream

```ts
await sdk.memory.updateSettings({ autoDreamEnabled: true });

const autoResult = await sdk.maybeAutoDream({
  currentSessionId: session.id,
  background: true,
});

console.log(autoResult.task?.id);
```

仓库示例：

- [examples/actoviq-dream.ts](../../examples/actoviq-dream.ts)

## 7. Compact

clean SDK 当前支持：

1. 自动 compact
2. reactive compact
3. API-oriented microcompact
4. compact history 与 continuity metadata 持久化

它的核心价值是：

1. 长对话时控制上下文长度
2. 在压缩后尽量保留连续性
3. 让 session-memory 和 compact 共同工作

下一章：

- [05-bridge-runtime.md](./05-bridge-runtime.md)
