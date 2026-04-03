# 03. 工具、权限、Skills 与 MCP

这一章开始，clean SDK 会真正像一个可组合的 agent 系统一样工作。

## 1. 先理解：工具和 skill 不是一回事

- **工具**负责直接做事，比如读文件、写文件、搜索、截图、委派任务。
- **Skill** 更像一套预设工作方式，比如系统化调试、验证结果、做 release 检查。

## 2. clean SDK 当前有哪些工具来源

clean SDK 可以把多种工具面组合到一起：

1. 通过 `tool(...)` 定义的本地自定义工具
2. `createActoviqFileTools(...)` 生成的文件工具
3. `createActoviqComputerUseToolkit(...)` 生成的 computer-use 工具
4. 注册 named agents 后自动可用的 `Task` 委派工具
5. 通过 MCP 挂进来的工具

## 3. 如何查看 clean SDK 当前工具面

现在 clean SDK 已经提供了工具目录 API：

```ts
const tools = await sdk.tools.listMetadata();
const catalog = await sdk.tools.getCatalog();

console.log(tools);
console.log(catalog.byCategory.file);
console.log(catalog.byCategory.computer);
```

每个工具元数据会包含：

1. `name`
2. `description`
3. `provider`
4. `category`
5. `server`
6. `readOnly`
7. `mutating`

仓库示例：

- [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)

## 4. clean SDK 里的 skills

现在 clean SDK 已经可以直接用 skills，不需要 bridge。

### 查看当前 skills

```ts
console.log(sdk.skills.listMetadata());
```

### 直接运行一个 skill

```ts
const result = await sdk.runSkill(
  'debug',
  '说明下一次发布前应该重点验证哪些内容。',
);
console.log(result.text);
```

### 在 session 中运行 skill

```ts
const session = await sdk.createSession({ title: 'Skill demo' });
const result = await session.runSkill(
  'remember',
  '记住：发布前必须等待 CI 和 npm pack --dry-run 通过。',
);
console.log(result.text);
```

### 注册自定义 skill

```ts
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

## 5. clean SDK 的“命令式 helper”替代

现在 clean SDK 也有不依赖 bridge 的命令式 helper：

```ts
console.log(sdk.slashCommands.listMetadata());

const contextResult = await sdk.slashCommands.run('context');
const toolsResult = await sdk.slashCommands.run('tools');
```

当前可用的 clean 替代命令：

1. `context`
2. `compact`
3. `memory`
4. `tools`
5. `skills`
6. `agents`

这些命令背后对应的是 typed API：

1. `sdk.context.overview(...)`
2. `sdk.context.describe(...)`
3. `sdk.context.compact(sessionId, ...)`
4. `sdk.context.memoryState(...)`
5. `sdk.context.tools(...)`
6. `sdk.context.skills()`
7. `sdk.context.agents()`

## 6. 权限、classifier 与 approver

### `permissionMode`

```ts
const sdk = await createAgentSdk({
  permissionMode: 'plan',
});
```

### `permissions`

```ts
const sdk = await createAgentSdk({
  permissions: [
    { toolName: 'Write', behavior: 'deny' },
    { toolName: 'Read', behavior: 'allow' },
  ],
});
```

### `classifier`

```ts
const sdk = await createAgentSdk({
  classifier: ({ publicName }) =>
    publicName === 'Write'
      ? { behavior: 'allow', reason: '当前流程下允许这次写入。' }
      : undefined,
});
```

### `approver`

```ts
const sdk = await createAgentSdk({
  permissions: [{ toolName: 'computer_*', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName.startsWith('computer_')
      ? { behavior: 'allow', reason: '这次运行允许执行。' }
      : { behavior: 'deny', reason: '未批准。' },
});
```

## 7. MCP 接入

当前支持：

1. 本地 MCP server
2. `stdio` MCP server
3. `streamable_http` MCP server

```ts
import { createAgentSdk, stdioMcpServer } from 'actoviq-agent-sdk';

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

仓库示例：

- [examples/actoviq-file-tools.ts](../../examples/actoviq-file-tools.ts)
- [examples/actoviq-computer-use.ts](../../examples/actoviq-computer-use.ts)
- [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
- [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)

下一章：

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
