# 03. 工具、权限、Skills 与 MCP

这一章是 SDK 真正开始“像一个 agent 一样工作”的关键。

## 1. 先理解：工具和 skills 不是一回事

- **工具**负责直接做事，比如读文件、写文件、搜索、打开网页、截图、委派任务。
- **Skill** 更像预设工作方式，比如系统化调试、做 release 检查、把任务交给 reviewer agent。

## 2. clean SDK 当前有哪些工具可以用？

clean SDK 现在可以组合多种工具来源。

### 自定义本地工具

```ts
import { z } from 'zod';
import { tool } from 'actoviq-agent-sdk';

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);
```

### 文件工具

```ts
import { createActoviqFileTools } from 'actoviq-agent-sdk';

const tools = createActoviqFileTools({ cwd: process.cwd() });
```

当前文件工具：

1. `Read`
2. `Write`
3. `Edit`
4. `Glob`
5. `Grep`

### Computer Use 工具

如果你要桌面 / 浏览器风格操作，可以用：

```ts
import { createActoviqComputerUseToolkit } from 'actoviq-agent-sdk';
```

当前 clean SDK 公开的 Computer Use 工具包括：

1. `computer_open_url`
2. `computer_type_text`
3. `computer_keypress`
4. `computer_read_clipboard`
5. `computer_write_clipboard`
6. `computer_take_screenshot`
7. `computer_run_workflow`

### Task 委派工具

如果你注册了 named agents，clean SDK 可以通过 `Task` 把任务交给另一个 agent。

### MCP 工具

MCP server 可以继续往当前 agent 表面挂更多工具。

## 3. 为什么你会看到“五个工具”和“二十几个工具”两种说法？

因为当前仓库有两条使用路径：

### 路径 A：clean SDK

```ts
createAgentSdk(...)
```

这里看到的是 clean SDK 自己组合出来的工具面：

1. 你显式传入的工具
2. 文件工具
3. computer-use 工具
4. Task 工具
5. MCP 工具

### 路径 B：bridge runtime

```ts
createActoviqBridgeSdk(...)
```

这里看到的是 runtime 风格的 built-in tool pool，加上 runtime skills、agents、subagents、MCP 能力，所以数量通常会明显更多。

## 4. clean SDK 里的 skills 现在怎么用？

现在 clean SDK 已经可以直接使用 skills，不需要 bridge。

### 当前 bundled skills

1. `debug`
2. `simplify`
3. `batch`
4. `verify`
5. `remember`
6. `stuck`
7. `loop`
8. `update-config`

### 查看当前 skills

```ts
const skills = sdk.skills.listMetadata();
console.log(skills);
```

### 直接运行一个 skill

```ts
const result = await sdk.runSkill(
  'debug',
  'Explain how this project should validate a release safely.',
);
console.log(result.text);
```

### 用 handle 方式反复调用

```ts
const debugSkill = sdk.skills.use('debug');
console.log(await debugSkill.metadata());
console.log((await debugSkill.run('Investigate why CI might fail.')).text);
```

### 在 session 中运行 skill

```ts
const session = await sdk.createSession({ title: 'Skill Demo' });
const result = await session.runSkill(
  'remember',
  'Remember that releases should wait for CI and npm pack --dry-run.',
);
console.log(result.text);
```

### 注册自定义 skill

```ts
import { skill } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk({
  skills: [
    skill({
      name: 'release-check',
      description: 'Review release readiness and summarize blockers.',
      prompt: 'You are executing the /release-check skill.\\n\\nTask:\\n$ARGUMENTS',
    }),
  ],
});
```

### fork skill：把 skill 委派给另一个 named agent

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: 'Review work and report the sharpest findings first.',
    },
  ],
  skills: [
    skill({
      name: 'review-with-reviewer',
      description: 'Fork work to the reviewer agent.',
      context: 'fork',
      agent: 'reviewer',
      prompt: 'You are executing the /review-with-reviewer skill.\\n\\nTask:\\n$ARGUMENTS',
    }),
  ],
});
```

### skills 可以从哪些目录自动加载？

clean SDK 当前会自动扫描：

1. `~/.actoviq/skills`
2. `<workDir>/.actoviq/skills`
3. `<workDir>/.actoviq/commands`

你也可以补充：

```ts
const sdk = await createAgentSdk({
  skillDirectories: ['E:/my-skills'],
});
```

## 5. bridge runtime 中的 skills 有什么意义？

bridge 仍然重要，但它的重点变成：

1. 查看 runtime 原生 skills
2. 复用 runtime 原生 skill 行为
3. 做 runtime parity 或 introspection

也就是说：

- 业务代码优先 clean skills
- runtime 对照和兼容优先 bridge skills

## 6. 如何查看 bridge runtime 当前有哪些 tools / skills？

```ts
const runtime = await sdk.getRuntimeInfo();
console.log(runtime.tools);
console.log(runtime.skills);
```

或者看更结构化的信息：

```ts
console.log(await sdk.tools.listMetadata());
console.log(await sdk.skills.listMetadata());
```

## 7. 权限控制：permissionMode、permissions、classifier、approver

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
      ? { behavior: 'allow', reason: 'Safe write in the current flow.' }
      : undefined,
});
```

### `approver`

```ts
const sdk = await createAgentSdk({
  permissions: [{ toolName: 'computer_*', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName.startsWith('computer_')
      ? { behavior: 'allow', reason: 'Approved for this run.' }
      : { behavior: 'deny', reason: 'Not approved.' },
});
```

## 8. MCP 怎么接入？

当前支持：

1. 本地 MCP server
2. `stdio` MCP server
3. `streamable_http` MCP server

示例：

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

## 9. 仓库示例

```bash
npm run example:actoviq-file-tools
npm run example:actoviq-computer-use
npm run example:actoviq-skills
npm run example:actoviq-introspection
```

对应文件：

- [examples/actoviq-file-tools.ts](../../examples/actoviq-file-tools.ts)
- [examples/actoviq-computer-use.ts](../../examples/actoviq-computer-use.ts)
- [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
- [examples/actoviq-skills.settings.example.json](../../examples/actoviq-skills.settings.example.json)
- [examples/actoviq-introspection.ts](../../examples/actoviq-introspection.ts)

`example:actoviq-skills` 会优先读取：

1. `examples/actoviq-skills.settings.local.json`
2. `~/.actoviq/settings.json`

如果你想直接跑仓库示例，可以先把：

- `examples/actoviq-skills.settings.example.json`

复制一份为本地忽略文件：

- `examples/actoviq-skills.settings.local.json`

下一章：

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
