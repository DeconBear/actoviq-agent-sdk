# 04. Agents、Swarm、Memory 与 Workspace

这一章讲的是 Hadamard SDK 里更高层的能力：不只是单轮对话，而是把 agent 组织成可以长期协作、持续运行、保留记忆的系统。

## 1. Named agents

如果你希望某些能力可以反复复用，先把它定义成命名 agent：

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: '优先报告 bug、回归和验证缺口。',
      systemPrompt:
        'You are a careful reviewer. Prioritize bugs, regressions, and missing verification.',
    },
  ],
});
```

之后就可以直接按角色运行：

```ts
const result = await sdk.runWithAgent(
  'reviewer',
  '请从发布前检查的角度审查这个仓库。',
);
```

## 2. Agent 委派

定义 named agents 后，Hadamard SDK 会向模型提供主工具 `Agent`，并保留
`Task` 作为兼容别名。

常用入口：

1. `sdk.createTaskTool()`
2. `sdk.runWithAgent(...)`
3. `sdk.createAgentSession(...)`
4. `sdk.tasks.list()`、`sdk.tasks.wait(...)` 与 `sdk.tasks.stop(...)`

`Agent` 支持前台与后台执行、具名 agent 实例、单次模型选择、显式工作目录
以及 `isolation: "worktree"`。后台任务结束后，结果会作为结构化通知注入父
会话；`SendMessage` 可以在下一个工具边界向运行中的 agent 追加指令，也可以
续接已经完成并持久化的 agent 会话。

Agent 也可以通过 Markdown 定义：

```md
---
name: reviewer
description: Review code without editing it
tools: Read, Grep, Glob
disallowedTools: Write, Edit
skills: release-checklist
effort: high
permissionMode: plan
memory: project
background: true
---
Prioritize correctness, regressions, and verification gaps.
```

项目定义放在 `.hadamard/agents/*.md`，用户定义放在
`~/.hadamard/agents/*.md`。优先级为：代码传入的定义、项目定义、用户定义。
定义还可以限制嵌套 agent、声明必需 MCP server、预加载 skill，以及启用
worktree 隔离。产生修改的 worktree 会保留并返回路径；没有修改的 worktree
会自动清理。

## 3. Swarm、Teammate 与 Side Session

如果你想做 leader + teammate 的协作模式，可以使用 swarm：

```ts
const team = sdk.swarm.createTeam({
  name: 'release-team',
  leader: 'lead',
  continuous: true,
});
```

常见操作：

1. `spawn(...)`
2. `message(...)`
3. `continueFromMailbox(...)`
4. `reenter(...)`
5. `runBackground(...)`
6. `transcript(...)`
7. `waitForIdle()`

你还可以给整个 team 设置统一的权限和审批语义：

```ts
team.setRuntimeContext({
  permissions: [{ toolName: 'write_note', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName === 'write_note'
      ? { behavior: 'allow', reason: '允许 teammate 写说明文档。' }
      : { behavior: 'deny', reason: '未预期的工具。' },
});
```

仓库示例：

- [examples/hadamard-swarm.ts](../../examples/hadamard-swarm.ts)

### GUI：让 Assistant 提议 Agent Graph

Global Assistant 与 Project Manager 都能读取 Team 并生成 Agent Graph 提案，但没有绕过确认直接写 Team 文件的能力：

1. 在 Assistant 面板新建或选择一个 Session。
2. Global Assistant 需要明确指定已登记的项目路径；Project Manager 固定使用当前项目。
3. 描述要增加、删除或重连的角色，例如“为 reviewer 增加失败后回到 implementer 的循环边”。
4. Proposal Card 会显示节点/边差异、解释、校验问题和目标项目。点击 Preview 只打开草稿画布，不写磁盘。
5. 校验失败时不能 Apply。若原 Team 在预览期间被外部修改，也会因基础版本指纹冲突而拒绝应用。
6. 点击 Apply 后才使用 Team 保存服务持久化；Reject 不产生写入。内置 Team 不能被覆盖，需要另存为新名称。

修改已有图时，稳定 ID 的旧节点会保留坐标，未变化边会保留手工端点；自动布局只补新增或缺少位置的节点。循环边采用语义化回边绕行，不把“几何最短”当作唯一目标。

Assistant 支持多个 Session。Global 与每个项目分别记住当前活动 Session；可以新建、恢复、重命名和归档，不会再自动删除“重复的 Manager Session”。

## 4. Workspace 管理

如果你不希望 agent 直接在当前目录工作，可以先创建独立 workspace，再把它传给 SDK。

可用 helper：

1. `createWorkspace(...)`
2. `createTempWorkspace(...)`
3. `createGitWorktreeWorkspace(...)`

```ts
const workspace = await createTempWorkspace({
  prefix: 'hadamard-demo-',
  copyFrom: './examples',
});

const sdk = await createAgentSdk({
  workDir: workspace.path,
});
```

## 5. Buddy

Buddy 不是单独的导航页，而是 Hadamard SDK 里的一种“陪伴式上下文能力”。它适合给 agent 注入固定风格、提示语气和持续性的 companion context。

常用入口：

1. `sdk.buddy.get()`
2. `sdk.buddy.hatch(...)`
3. `sdk.buddy.mute() / unmute()`
4. `sdk.buddy.pet()`
5. `sdk.buddy.getPromptContext()`

一个最小例子：

```ts
await sdk.buddy.hatch({
  name: 'Luna',
  persona: 'A calm engineering companion.',
});

console.log(await sdk.buddy.state());
```

Buddy 的内容会通过 prompt context 进入 Hadamard SDK 主链，所以它更像“长期陪伴配置”，而不是一次性工具。

## 6. Memory、Session-Memory 与 Relevant Memories

Hadamard SDK 当前已经提供：

1. relevant memories 选择
2. session-memory prompt / summary helper
3. compact state 检查
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

- [examples/hadamard-memory.ts](../../examples/hadamard-memory.ts)
- [examples/hadamard-session-memory.ts](../../examples/hadamard-session-memory.ts)

## 7. 可审阅 Memory 提案与 Remote Worker

模型发现稳定规则时只创建 Memory Proposal，不会直接写长期记忆。交互面使用：

```text
/memory proposals
/memory apply <proposal-id>
/memory reject <proposal-id>
```

Apply 前会展示目标、内容和来源；Reject 不产生持久写入。项目 `.hadamard/rules/` 与用户规则按 path glob、priority 和 provenance 解析，`/rules why` 可解释本轮为何命中某条规则。

Remote Worker 是可自托管协议，不绑定特定云厂商。它提供 durable job、事件 cursor、lease/heartbeat、断线续传、takeover、approval 回传和内容哈希 artifact。远端 worker 不能自行批准高风险工具；审批仍回到原 Session policy。artifact 会校验大小、哈希与 workspace path 映射，避免把远端路径直接写进本地任意位置。

## 8. Dream：长期记忆整理

Dream 可以理解成一次“对最近若干会话做记忆整理和巩固”的 Hadamard SDK 过程。它不会单独占据教程导航，而是作为 memory 系统的一部分来理解。

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

- [examples/hadamard-dream.ts](../../examples/hadamard-dream.ts)

## 9. Compact

Hadamard SDK 当前支持：

1. 自动整段摘要 compact（in-loop + 会话级）
2. provider 拒绝对话过长时的 reactive compact
3. 超大工具结果在**写入时**落盘归档
4. compact history 和 continuity metadata 持久化

**前缀稳定：** 回合之间保持 append-only，**不会**滑动清空更早的 `tool_result`（否则会打断 DeepSeek 等自动前缀缓存）。默认 `apiMicrocompactClearToolResults = false`。Anthropic 主机仍可打 `cache_control`；DeepSeek 的 `prompt_cache_hit_tokens` 会映射为本地 `cache_read_input_tokens`。

它最重要的作用是：

1. 长对话时控制上下文长度
2. 压缩后尽量保持推理连续性
3. 让 session-memory 和 compact 一起工作
4. 在第三方自动缓存场景下尽量维持高命中率

手动 compact 可以附加摘要要求，并以结构化结果返回失败状态：

```ts
const result = await session.compact({
  force: true,
  summaryInstructions: '保留未解决的测试失败和精确文件路径。',
});

if (!result.compacted) {
  console.error(result.reason, result.error, result.consecutiveFailures);
}
```

compact 历史与连续三次失败后的断路器状态都会随会话保存，因此 `resumeSession()` 不会重置恢复状态。

## 10. 模块化 Runtime 的 Agent Profiles

`createAgentSdk()` 的 named agents、swarm、buddy、dream 和 memory 是产品级组合能力。模块化 Runtime 则通过不可变 `AgentSpec` 与 profile 描述依赖：

```ts
import {
  buildProfile,
  inspectProfile,
  runProfile,
} from 'actoviq-agent-sdk/profiles';

const profile = buildProfile('chat', {
  model: {
    provider: 'openai-responses',
    model: 'gpt-4.1-mini',
  },
});

console.log(inspectProfile(profile));

const result = await runProfile(
  runtime,
  profile,
  '请概括当前项目。',
);

console.log(result.output);
```

内置 profile 包括：

1. `chat`
2. `coding`
3. `research`
4. `workflow`
5. `supervisor`
6. `background`

Profile 不是“打开一个名称就自动拥有全部能力”。它会声明 required services、middleware、tools、workspace 和安全预期；`runProfile()` 在执行前检查 runtime 组合，缺能力就明确失败。例如 `coding` 需要 workspace service、workspace boundary/policy middleware、读写工具以及 `workspaceId`。

这样做的目的，是让新应用的 agent 能力可检查、可测试，而不是由隐式全局状态决定。需要自动扫描 Markdown agent 定义、Team/Swarm 或 GUI 编排时，继续使用 `createAgentSdk()` 交互入口。

下一章：

- [05-testing-troubleshooting-cheatsheet.md](./05-testing-troubleshooting-cheatsheet.md)
