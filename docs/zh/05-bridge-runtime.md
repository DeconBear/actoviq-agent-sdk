# 05. Bridge Runtime 兼容说明

这一章解释什么是 bridge，以及什么时候才需要使用它。

## 1. 前置条件 — 链接运行时 bundle

Bridge SDK 依赖 Claude Code 的运行时 bundle（`runtime.bundle.br`）。由于许可证限制，该文件**不包含**在 actoviq-agent-sdk 包中。

如果你已安装 Claude Code，可以链接它的 bundle：

```bash
# Claude Code 的 npm 包名为 @anthropic-ai/claude-code
# bundle 路径：<claude-code-root>/vendor/actoviq-runtime/runtime.bundle.br

# macOS / Linux（npm 全局安装）
npx actoviq-link-runtime /usr/local/lib/node_modules/@anthropic-ai/claude-code

# macOS / Linux（nvm 安装）
npx actoviq-link-runtime ~/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code

# Windows
npx actoviq-link-runtime %AppData%\npm\node_modules\@anthropic-ai\claude-code

# 或者让 npm 自己找：
npx actoviq-link-runtime "$(npm root -g)/@anthropic-ai/claude-code"
```

或者设置环境变量：

```bash
export ACTOVIQ_RUNTIME_BUNDLE="/path/to/runtime.bundle.br"
```

没有这个 bundle，bridge SDK 功能将不可用。

## 2. bridge 是什么

bridge 可以理解成一层兼容适配层。它暴露的是更偏 runtime 风格的执行路径。

入口：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. 什么情况下才需要 bridge

更适合使用 bridge 的场景：

1. 你要研究现有 runtime 的行为
2. 你要查看 runtime 当前有哪些 tools / skills / agents
3. 你要分析 runtime 事件流
4. 你要做兼容层、迁移层或对照测试

如果你是在开发一个新的业务项目，通常优先使用 clean SDK：

```ts
createAgentSdk()
```

bridge 更适合“兼容”和“研究”，不是默认主路径。

## 3. 最小 bridge 示例

```ts
import {
  createActoviqBridgeSdk,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

const result = await sdk.run('检查 examples 目录，并总结 quickstart.ts。');

console.log(result.text);
console.log(result.events.length);
```

## 4. Runtime Introspection

bridge 可以查看当前 runtime 暴露出来的能力：

```ts
const runtime = await sdk.getRuntimeInfo();

console.log(runtime.tools);
console.log(runtime.skills);
console.log(runtime.agents);
```

仓库示例：

- [examples/bridge-introspection.ts](../../examples/bridge-introspection.ts)
- [examples/bridge-sdk.ts](../../examples/bridge-sdk.ts)

## 5. Bridge Helper

bridge 侧还支持：

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 6. Bridge 事件 Helper

如果你要分析 runtime 输出的事件流，可以使用：

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

下一章：

- [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
