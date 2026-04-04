# 从 0 到 1：用 clean SDK 做一个完整可用的 Agent 项目

这篇教程的目标不是只让你跑一个 demo，而是手把手带你做出一个“能持续对话、能调用工具、能使用 skills、能保留会话”的 clean SDK 项目。整篇教程只使用 `createAgentSdk()`，不依赖 bridge。

## 你最终会得到什么

做完之后，你会有一个可以直接运行的终端聊天程序，具备这些能力：

1. 启动时加载本地 JSON 配置
2. 支持多轮会话，保留上下文
3. 支持流式输出
4. 支持本地工具调用
5. 支持 clean skills
6. 支持在代码里指定工作目录
7. 支持后续继续扩展 MCP、memory、buddy、dream、swarm 和 computer-use

## 一、准备工作

请先确认：

1. 你已经安装 Node.js 18 或更高版本
2. 你已经有一个可用的模型服务配置文件
3. 你希望先做一个终端版聊天程序，而不是 Web 应用

安装依赖：

```bash
npm install actoviq-agent-sdk zod
```

## 二、准备配置文件

推荐先准备一个 JSON 文件，例如：`agent.settings.json`

```json
{
  "ACTOVIQ_BASE_URL": "https://your-model-endpoint.example.com/v1",
  "ACTOVIQ_AUTH_TOKEN": "your-token",
  "ACTOVIQ_MODEL": "your-model-name"
}
```

如果你的配置结构是：

```json
{
  "env": {
    "ACTOVIQ_BASE_URL": "https://your-model-endpoint.example.com/v1",
    "ACTOVIQ_AUTH_TOKEN": "your-token",
    "ACTOVIQ_MODEL": "your-model-name"
  }
}
```

也可以正常加载。

## 三、创建项目结构

建议从一个最小结构开始：

```text
my-clean-agent/
├─ package.json
├─ agent.settings.json
└─ src/
   └─ app.ts
```

如果你后面要继续扩展，可以再增加这些目录：

```text
src/
├─ app.ts
├─ tools/
├─ skills/
└─ prompts/
```

## 四、先实现一个最小可运行版本

在 `src/app.ts` 中先写下面这版代码：

```ts
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { z } from 'zod';
import {
  createAgentSdk,
  createActoviqFileTools,
  loadJsonConfigFile,
  skill,
  tool,
} from 'actoviq-agent-sdk';

const CONFIG_PATH = path.resolve(process.cwd(), 'agent.settings.json');
const WORK_DIR = process.cwd();

await loadJsonConfigFile(CONFIG_PATH);

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: '计算两个数字的和。',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);

const releaseCheck = skill({
  name: 'release-check',
  description: '检查发布前需要关注的事项。',
  prompt: '你正在执行 release-check skill。\n\n任务：\n$ARGUMENTS',
  inheritDefaultTools: false,
  inheritDefaultMcpServers: false,
  allowedTools: [],
});

const sdk = await createAgentSdk({
  workDir: WORK_DIR,
  tools: [
    ...createActoviqFileTools({ cwd: WORK_DIR }),
    addNumbers,
  ],
  skills: [releaseCheck],
});

const rl = readline.createInterface({ input, output });
const session = await sdk.createSession({ title: 'My Clean Agent' });

console.log('Agent 已启动，输入 exit 可退出。');
console.log(`session.id = ${session.id}`);

try {
  while (true) {
    const prompt = (await rl.question('\nYou> ')).trim();
    if (!prompt) {
      continue;
    }

    if (['exit', 'quit', '/exit', ':q'].includes(prompt.toLowerCase())) {
      break;
    }

    if (prompt.startsWith('/skill ')) {
      const args = prompt.slice('/skill '.length).trim();
      const result = await session.runSkill('release-check', args || '请总结当前项目的发布检查项。');
      console.log(`\nAgent> ${result.text}`);
      continue;
    }

    const stream = session.stream(prompt, {
      systemPrompt: '你是一个清晰、可靠、简洁的工程助手。',
    });

    output.write('\nAgent> ');
    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        output.write(event.delta);
      }
    }

    const result = await stream.result;
    output.write('\n');

    if (result.toolCalls.length > 0) {
      console.log('调用过的工具：', result.toolCalls.map(call => call.name));
    }
  }
} finally {
  rl.close();
  await sdk.close();
}
```

## 五、这段代码到底做了什么

### 1. 加载配置

```ts
await loadJsonConfigFile(CONFIG_PATH);
```

这一步会把 `agent.settings.json` 里的配置加载进运行时。之后调用 `createAgentSdk()` 时，就可以直接读取这些配置。

### 2. 指定工作目录

```ts
const WORK_DIR = process.cwd();
```

这会影响：

1. 文件工具默认读写的目录
2. agent 分析代码或文本时的上下文目录
3. 某些 memory / workspace 相关逻辑的项目路径判断

如果你要让 agent 固定在某个仓库工作，可以直接改成：

```ts
const WORK_DIR = 'E:/your/project';
```

### 3. 注册本地工具

```ts
const addNumbers = tool(...)
```

这表示你自己提供了一个工具给模型调用。只要模型认为有必要，它就可以调用 `add_numbers`。

### 4. 注册 clean skill

```ts
const releaseCheck = skill(...)
```

这表示你给 clean SDK 提供了一个可以重复使用的 skill。之后你可以：

1. 用 `sdk.runSkill(...)`
2. 用 `session.runSkill(...)`
3. 或者做成用户输入里的一个特殊命令

### 5. 创建 session

```ts
const session = await sdk.createSession({ title: 'My Clean Agent' });
```

这一步非常重要。它表示我们不是做“一问一答”的临时调用，而是在做“有历史上下文”的持续会话。

你可以通过 `session.id` 拿到它的唯一标识。

## 六、运行项目

在你的项目目录里执行：

```bash
npx tsx src/app.ts
```

或者你也可以在 `package.json` 里加一个脚本：

```json
{
  "scripts": {
    "dev": "tsx src/app.ts"
  }
}
```

然后运行：

```bash
npm run dev
```

## 七、如何和这个 Agent 交互

启动后，你可以这样输入：

```text
You> 你好，请介绍一下你自己
You> 请读取当前目录下的 README.md 并总结重点
You> 请用工具计算 18 + 24
You> /skill 请给我一份发布前检查清单
```

你会看到：

1. 普通问题会走正常对话
2. 需要工具时会自动调用工具
3. `/skill ...` 会直接执行你注册的 clean skill
4. 同一个 session 会持续保留上下文

## 八、如何查看和恢复会话

### 查看当前 session ID

程序启动时已经打印了：

```ts
console.log(`session.id = ${session.id}`);
```

你也可以在运行中随时打印它。

### 查看已有历史会话

```ts
const sessions = await sdk.sessions.list();
console.log(sessions);
```

### 恢复旧会话

```ts
const oldSession = await sdk.resumeSession('your-session-id');
await oldSession.send('继续刚才的话题');
```

## 九、这些历史会话保存在哪里

默认情况下，clean SDK 会把 session 数据保存到：

```text
~/.actoviq/actoviq-agent-sdk
```

如果你想改保存位置，可以在创建 SDK 时指定：

```ts
const sdk = await createAgentSdk({
  workDir: WORK_DIR,
  sessionDirectory: 'E:/my-agent-sessions',
});
```

### session ID 能自定义吗？

当前不能直接手动指定 `session.id`。

你可以自定义的是：

1. `title`
2. `metadata`
3. `tags`
4. `sessionDirectory`

## 十、如果你要继续扩展，下一步最值得做什么

你可以继续往这几个方向扩展：

### 方向 1：增加更多本地工具

例如：

1. 读取数据库
2. 调内部 HTTP API
3. 调用企业脚本
4. 访问本地知识库

### 方向 2：增加更多 skills

例如：

1. `review-code`
2. `plan-release`
3. `summarize-log`
4. `triage-bug`

### 方向 3：接 MCP

如果你希望复用外部工具生态，可以接 MCP server。

### 方向 4：接入 buddy 与 dream

如果你希望 agent 更有持续性和“陪伴感”，可以继续补：

1. `sdk.buddy.hatch(...)`
2. `sdk.buddy.getPromptContext()`
3. `sdk.dreamState()`
4. `session.dream(...)`

### 方向 5：做成更完整的终端程序

你可以在当前这个基础上继续加：

1. `/help`
2. `/tools`
3. `/skills`
4. `/session`
5. `/resume`
6. `/memory`

### 方向 6：接入 swarm 与 workspace

如果你后面要做多代理协作或隔离工作目录，可以再继续接：

1. `sdk.swarm.createTeam(...)`
2. `createTempWorkspace(...)`
3. `createGitWorktreeWorkspace(...)`

## 十一、什么时候才需要 bridge

这篇教程故意只使用 clean SDK，因为它已经足够支撑绝大多数业务项目。

只有在这些场景里，你才更可能需要 bridge：

1. 你要研究兼容 runtime 的原生行为
2. 你要接已有 runtime 的内置能力池
3. 你要做 runtime 对照、迁移或兼容接入

如果你是要开发自己的产品、机器人或自动化助手，建议优先坚持 clean SDK。

## 十二、你可以直接参考哪些现成示例

如果你想对照更多官方示例，可以继续看：

1. [examples/quickstart.ts](../../examples/quickstart.ts)
2. [examples/actoviq-interactive-agent.ts](../../examples/actoviq-interactive-agent.ts)
3. [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
4. [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)
5. [examples/actoviq-swarm.ts](../../examples/actoviq-swarm.ts)

## 十三、你下一步应该怎么做

如果你希望最稳地开始：

1. 先把本教程里的 `src/app.ts` 跑起来
2. 先只保留一个本地工具和一个 skill
3. 确认 session、stream、tool 调用都通了
4. 再逐步加 MCP、memory、swarm、workspace

这样你会更容易定位问题，也更容易把 clean SDK 用成自己的产品底座。
