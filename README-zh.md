# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)

[English](./README.md) | [中文](./README-zh.md)

Actoviq Agent SDK 是一个实验性的 TypeScript Agent SDK，支持 clean SDK 路线、MCP 集成、memory / compact helper，以及可选的 runtime bridge 路线。

当前仓库仍在持续开发中，API 和运行时行为后续可能继续调整。欢迎提交 Issue 和 PR。

## 安装

```bash
npm install actoviq-agent-sdk zod
```

本地示例默认读取：

```text
~/.actoviq/settings.json
```

如果你想用自己的 JSON 配置文件，也可以先调用 `loadJsonConfigFile(...)`。

## 快速启动

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

运行仓库自带示例：

```bash
npm run example:quickstart
npm run example:actoviq-interactive-agent
```

## 教程入口

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- 中文教程: [docs/zh/README.md](./docs/zh/README.md)

如果你想直接运行一个带流式输出和工具调用的终端聊天程序，先看：

- [examples/actoviq-interactive-agent.ts](./examples/actoviq-interactive-agent.ts)

如果你想先走 clean SDK 路线，推荐从这里开始：

- [examples/quickstart.ts](./examples/quickstart.ts)
- [examples/actoviq-skills.ts](./examples/actoviq-skills.ts)

## 欢迎贡献

欢迎贡献代码、文档和示例。如果你发现问题、教程缺口或能力对齐问题，都欢迎开 Issue 或直接发 PR。

项目采用 [MIT License](./LICENSE)。
