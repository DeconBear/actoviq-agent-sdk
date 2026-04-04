# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/actoviq-agent-sdk/)

[English](./README.md) | [中文](./README-zh.md)

文档站地址：https://deconbear.github.io/actoviq-agent-sdk/

Actoviq Agent SDK 是一个实验性的 TypeScript Agent SDK，面向多工具、多会话、多代理工作流。当前项目以 clean SDK 作为公开主路径，同时保留可选的兼容 bridge 路径。

项目仍在持续开发中，API 和运行行为后续还会继续打磨。欢迎提交 Issue 和 PR。

## 安装

```bash
npm install actoviq-agent-sdk zod
```

本地示例默认读取：

```text
~/.actoviq/settings.json
```

如果你希望使用自定义 JSON 配置文件，也可以先调用 `loadJsonConfigFile(...)`。

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
npm run example:actoviq-agent-helpers
```

## 教程入口

- English tutorial: [docs/en/README.md](./docs/en/README.md)
- 中文教程: [docs/zh/README.md](./docs/zh/README.md)
- GitHub Pages 文档站：
  - https://deconbear.github.io/actoviq-agent-sdk/
- 从 0 到 1 搭建完整 clean SDK 项目：
  - [docs/zh/07-build-a-complete-clean-agent.md](./docs/zh/07-build-a-complete-clean-agent.md)

如果你想直接运行一个带流式输出和工具调用的终端聊天程序，优先看：

- [examples/actoviq-interactive-agent.ts](./examples/actoviq-interactive-agent.ts)

如果你想先按 clean SDK 主路径上手，推荐从这里开始：

- [examples/quickstart.ts](./examples/quickstart.ts)
- [examples/actoviq-skills.ts](./examples/actoviq-skills.ts)
- [examples/actoviq-agent-helpers.ts](./examples/actoviq-agent-helpers.ts)

bridge 相关文档现在主要作为兼容和运行时接入说明。新的业务接入建议优先使用 clean SDK。

## 欢迎贡献

欢迎贡献代码、文档和示例。如果你发现问题、教程缺口或者能力对齐问题，都欢迎提 Issue 或直接发 PR。

项目采用 [MIT License](./LICENSE)。
