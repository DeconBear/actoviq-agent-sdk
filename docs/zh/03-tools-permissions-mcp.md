# 03. 工具、权限、Skills 与 MCP

这一章会把 clean SDK 里“真正干活”的能力讲清楚：工具怎么接、权限怎么管、skills 怎么用、MCP 又处在什么位置。

## 1. 先分清：工具和 Skill 不是一回事

- 工具：负责直接执行动作，比如读写文件、搜索、委派任务、操作浏览器或桌面。
- Skill：更像一套预设工作方式，用来组织模型如何思考、如何执行、什么时候调用工具。

你可以把它理解成：

1. 工具决定“能做什么”
2. Skill 决定“怎么做这件事更稳、更像一个固定工作流”

## 2. clean SDK 里有哪些工具

clean SDK 当前可以组合这些工具来源：

1. 你自己用 `tool(...)` 定义的本地工具
2. `createActoviqFileTools(...)` 生成的文件工具
3. `createActoviqComputerUseToolkit(...)` 生成的 computer-use 工具
4. 注册 named agents 后自动出现的 `Task` 委派工具
5. 通过 MCP 挂进来的外部工具

最常见的内置 clean 工具面包括：

1. `Read`
2. `Write`
3. `Edit`
4. `Glob`
5. `Grep`
6. `Task`
7. `computer_*` 一组桌面/浏览器替代工具

## 3. 如何查看当前有哪些工具

```ts
const tools = await sdk.tools.listMetadata();
const catalog = await sdk.tools.getCatalog();

console.log(tools);
console.log(catalog.byCategory.file);
console.log(catalog.byCategory.computer);
```

每个工具元数据会告诉你：

1. `name`
2. `description`
3. `provider`
4. `category`
5. `readOnly`
6. `mutating`

仓库示例：

- [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)
- [examples/actoviq-file-tools.ts](../../examples/actoviq-file-tools.ts)

## 4. 自定义本地工具

```ts
import { z } from 'zod';
import { createAgentSdk, tool } from 'actoviq-agent-sdk';

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers together.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);

const sdk = await createAgentSdk({
  tools: [addNumbers],
});
```

## 5. Skills：clean SDK 现在已经可以直接用

当前 clean SDK 已经支持：

1. bundled skills
2. 自定义 skills
3. 从 `~/.actoviq/skills`、`.actoviq/skills` 自动加载 skills
4. `inline` / `fork` 两种运行模式

常用入口：

```ts
console.log(sdk.skills.listMetadata());

const debugResult = await sdk.runSkill(
  'debug',
  '请分析这个仓库在发布前最应该优先验证哪些内容。',
);

const session = await sdk.createSession({ title: 'Skill Demo' });
const rememberResult = await session.runSkill(
  'remember',
  '记住：发版前必须等待 CI 和 npm pack --dry-run 都通过。',
);
```

注册自定义 skill：

```ts
import { createAgentSdk, skill } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk({
  skills: [
    skill({
      name: 'release-check',
      description: '检查发布准备情况并总结阻塞项。',
      prompt: 'You are executing the /release-check skill.\\n\\nTask:\\n$ARGUMENTS',
    }),
  ],
});
```

仓库示例：

- [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)

## 6. Dream：长期记忆整合

clean SDK 现在也已经有独立的 `dream` 能力，用来对最近若干会话做一次记忆整合。

常用入口：

```ts
const state = await sdk.dreamState();
console.log(state);

const session = await sdk.createSession({ title: 'Dream Demo' });
const dreamResult = await session.dream({
  extraContext: '把最近关于发布流程、工具使用方式和稳定约束整理成长期记忆。',
});

console.log(dreamResult.result?.text);
```

自动 dream 入口：

```ts
await sdk.memory.updateSettings({ autoDreamEnabled: true });
await sdk.maybeAutoDream({
  currentSessionId: session.id,
  background: true,
});
```

仓库示例：

- [examples/actoviq-dream.ts](../../examples/actoviq-dream.ts)

## 7. 权限、classifier、approver

如果你不希望 agent 任意调用工具，可以配权限层。

### 直接给规则

```ts
const sdk = await createAgentSdk({
  permissions: [
    { toolName: 'Read', behavior: 'allow' },
    { toolName: 'Write', behavior: 'ask' },
  ],
});
```

### 用 classifier 做自动判断

```ts
const sdk = await createAgentSdk({
  classifier: ({ publicName, input }) => {
    if (publicName === 'Write') {
      return {
        behavior: 'ask',
        reason: `Write needs manual review: ${JSON.stringify(input)}`,
      };
    }
  },
});
```

### 用 approver 接管 ask

```ts
const sdk = await createAgentSdk({
  approver: ({ publicName }) => {
    if (publicName === 'Write') {
      return { behavior: 'allow', reason: 'Approved for this run.' };
    }
    return { behavior: 'deny', reason: 'Unexpected tool.' };
  },
});
```

## 8. MCP 是干嘛的

MCP 的作用是把“外部工具服务器”接进 SDK。

例如：

```ts
import {
  createAgentSdk,
  stdioMcpServer,
} from 'actoviq-agent-sdk';

const sdk = await createAgentSdk({
  mcpServers: [
    stdioMcpServer({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    }),
  ],
});
```

## 9. clean 命令式 helper

clean SDK 现在也有不依赖 bridge 的命令式 helper：

```ts
console.log(sdk.slashCommands.listMetadata());

const contextResult = await sdk.slashCommands.run('context');
const memoryResult = await sdk.slashCommands.run('memory', {
  sessionId: 'your-session-id',
});
const dreamResult = await sdk.slashCommands.run('dream', {
  sessionId: 'your-session-id',
  args: '把最近稳定的项目约束整理进长期记忆。',
});
```

当前可用的 clean 命令替代包括：

1. `context`
2. `compact`
3. `memory`
4. `dream`
5. `tools`
6. `skills`
7. `agents`

下一章：

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
