# 03. 工具、权限、Skills 与 MCP

这一章会把 Hadamard SDK 里“真正干活”的能力讲清楚：工具怎么接、权限怎么管、skills 怎么用、MCP 又处在什么位置。

## 1. 先分清：工具和 Skill 不是一回事

- 工具：负责直接执行动作，比如读写文件、搜索、委派任务、操作浏览器或桌面。
- Skill：更像一套预设工作方式，用来组织模型如何思考、如何执行、什么时候调用工具。

你可以把它理解成：

1. 工具决定“能做什么”
2. Skill 决定“怎么做这件事更稳、更像一个固定工作流”

## 2. Hadamard SDK 里有哪些工具

Hadamard SDK 当前可以组合这些工具来源：

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

## 5. Skills：Hadamard SDK 现在已经可以直接用

当前 Hadamard SDK 已经支持：

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

Hadamard SDK 现在也已经有独立的 `dream` 能力，用来对最近若干会话做一次记忆整合。

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

会话级权限模式和规则会持久化，并在恢复会话时继续生效：

```ts
await session.setPermissionContext({
  mode: 'default',
  permissions: [{ toolName: 'Bash', behavior: 'ask' }],
  approver,
});

const restored = await sdk.resumeSession(session.id);
console.log(restored.permissionContext);
```

只有可序列化的模式和规则会写入会话；classifier 与 approver 回调需要由当前进程重新绑定。`bypassPermissions` 仍会执行硬安全检查，`acceptEdits` 只自动允许文件编辑工具，不会自动允许任意 shell 命令；`plan` 会阻止未被更高优先级规则或 classifier 明确允许的变更型工具。

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

Hadamard SDK 也提供命令式 helper：

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

## 10. Plan 模式与 Goal 模式不是一回事

Plan 模式控制“这一阶段能不能产生修改”：

```text
/plan
```

进入后，Agent 可以调查代码、读取配置并写计划，但变更型工具受 Plan 权限边界约束。退出时展示计划并等待确认；没有确认，不应把计划当成实施授权。GUI、TUI 和 CLI 使用同一个命令定义与权限语义。

Goal 模式控制“多轮执行要持续追求什么目标”：

```text
/goal 完成发布前检查并修复所有回归
/goal
/goal pause
/goal resume
/goal clear
```

Goal 随 Session 保存。runtime 每轮只注入短目标上下文，并记录 token、turn、tool 使用和进度证据。为了避免模型在工作未完成时自行宣布成功，`complete` 必须由 `UpdateGoal` 携带运行证据；普通 UI 命令只能查看、创建、暂停、恢复或清除目标。

可以先用 Plan 模式形成获批方案，再用 Goal 约束长时间实施。Plan 结束不表示 Goal 完成，Goal 存在也不会自动授予写权限。

## 11. Managed Policy、OS Sandbox 与审计

权限决策和 OS 隔离是两层：

- permission policy 决定工具调用是 `allow`、`ask` 还是 `deny`。
- sandbox 在执行层限制读写根、网络和子进程；平台能力不足时会明确标记 degraded。

项目策略放在 `.actoviq/policy.json`，用户和主机策略分别放在 `~/.actoviq/policy/user.json`、`~/.actoviq/policy/host.json`。高权威策略可以锁定设置：

```json
{
  "version": 1,
  "revision": 1,
  "scope": "project",
  "settings": {
    "model": "medium",
    "sandbox": { "network": { "mode": "deny" } },
    "plugins": {
      "allowedPublishers": ["example.org"],
      "allowedCapabilities": ["tools", "skills"]
    }
  },
  "rules": [
    { "id": "no-shell", "effect": "deny", "tool": "Bash" }
  ],
  "lockedSettings": ["model", "sandbox"],
  "updatedAt": "2026-07-30T00:00:00.000Z"
}
```

托管 deny 会在 `bypassPermissions` 之前生效。插件在安装、启用或信任前也会检查 registry、publisher 和 capability allowlist。Settings 会显示有效策略来源和锁定字段；决策审计写入独立的脱敏 append-only 日志。

## 12. Typed Hooks 与插件包

Typed Hooks 覆盖 Session、Turn、Model、Tool、Permission、Compact、Stop、Worktree 等生命周期事件，handler 可以是 command、prompt 或 HTTP。Hook 配置先做 schema 校验，再按稳定顺序执行；旧式三类 shell hook 仍通过兼容 adapter 工作。

插件命令在 GUI/TUI/CLI 使用同一语义：

```text
/plugin search <query>
/plugin install <local-package-directory>
/plugin pin <plugin-id> <version>
/plugin enable <plugin-id>
/plugin trust <plugin-id>
```

包 manifest 使用稳定 ID、SemVer、package-local entry、integrity、publisher、signature、capabilities 和 permissions。安装版本不可变，更新会安装新版本；符号链接、特殊文件、路径穿越和 integrity 不匹配会被拒绝。

## 13. 模块化 Runtime 的 ToolRegistry 与 ToolPolicy

`tool(...)`、`permissions`、MCP 和 clean helpers 属于 `createAgentSdk()` 的高层组合接口。模块化 Runtime 使用更小的 `RuntimeTool` contract：

```ts
import {
  AgentRuntime,
  ToolRegistry,
  type RuntimeTool,
  type ToolPolicy,
} from 'actoviq-agent-sdk/runtime';

const addNumbers: RuntimeTool<unknown, { a: number; b: number }, number> = {
  descriptor: {
    name: 'add_numbers',
    description: 'Add two numbers.',
    input: {
      parse(value) {
        const input = value as { a?: unknown; b?: unknown };
        if (typeof input.a !== 'number' || typeof input.b !== 'number') {
          throw new TypeError('a and b must be numbers');
        }
        return { a: input.a, b: input.b };
      },
      jsonSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    behavior: {
      effect: 'read',
    },
  },
  execute: (_context, input) => input.a + input.b,
};

const policy: ToolPolicy = {
  authorize({ tool }) {
    return tool.behavior?.effect === 'read'
      ? { type: 'allow' }
      : { type: 'deny', reason: 'Only read tools are allowed.' };
  },
};

const tools = new ToolRegistry([addNumbers]);

const runtime = new AgentRuntime({
  models,
  tools,
  toolPolicy: policy,
});
```

其中 `models` 是前一章构造的 `ModelRegistry`。实际项目还应注意：

- 未声明 `behavior.effect` 的工具按 `side-effect` 处理，不会默认当成只读。
- `effect` 只描述副作用语义；是否允许由 `ToolPolicy` 决定。
- 需要人工确认时返回 `interrupt`，并为 runtime 配置 checkpoint store，之后使用 interruption decision 恢复。
- Runtime v2 不会自动扫描 MCP 或 skills。要继续使用自动发现和交互式权限 UI，选择 `createAgentSdk()` 入口。

下一章：

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
