# 01. 环境准备与快速启动

这一章的目标很简单：尽快把 SDK 跑起来。

## 1. 安装

如果你在自己的项目里使用：

```bash
npm install actoviq-agent-sdk zod
```

如果你在当前仓库里调试：

```bash
npm install
```

## 2. 准备 JSON 配置

本地最简单的方式是准备：

```text
~/.actoviq/settings.json
```

示例：

```json
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "your-token",
    "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
    "ACTOVIQ_DEFAULT_SONNET_MODEL": "your-model"
  }
}
```

如果你不想使用默认位置，也可以在代码里先调用 `loadJsonConfigFile(...)` 加载任意路径的 JSON。

## 3. 第一个 SDK 调用

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

try {
  const result = await sdk.run('请用一句话做自我介绍。');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

## 4. 直接运行仓库示例

```bash
npm run example:quickstart
```

对应文件：

- [examples/quickstart.ts](../../examples/quickstart.ts)

## 5. 一个最小可用的流式聊天机器人

下面这段代码就是一个可以直接拿来改的最小聊天机器人。你只要把自己的 JSON 配置路径接上，就可以在终端里持续聊天，并且保留同一个 session 的上下文。

```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  createAgentSdk,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

await loadJsonConfigFile('E:/configs/my-agent-config.json');

const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Simple Chat Bot' });
const rl = readline.createInterface({ input, output });

try {
  while (true) {
    const message = (await rl.question('你> ')).trim();
    if (!message || message === 'exit' || message === 'quit') {
      break;
    }

    const stream = session.stream(message);
    process.stdout.write('机器人> ');

    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        process.stdout.write(event.delta);
      }
    }

    const result = await stream.result;
    process.stdout.write(`\n[session=${session.id} stop=${result.stopReason}]\n\n`);
  }
} finally {
  rl.close();
  await sdk.close();
}
```

## 6. 一个可以直接使用的交互程序示例

如果你想直接运行一个更完整的程序，而不是自己先写循环，推荐直接看：

- [examples/actoviq-interactive-agent.ts](../../examples/actoviq-interactive-agent.ts)

它已经是一个可直接使用的交互式终端程序，具备：

1. 流式输出
2. 持续对话循环
3. 工具调用
4. 可配置工作空间路径
5. 可配置 JSON 配置路径

运行方式：

```bash
npm run example:actoviq-interactive-agent
```

下一章：

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
