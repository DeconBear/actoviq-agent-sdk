# 05. Bridge Runtime 兼容说明

这一章解释 bridge 路线是什么，以及它现在更适合哪些场景。

## 1. bridge 是什么

bridge 可以理解成一层兼容适配层，它暴露的是偏 runtime 风格的执行路径。

入口：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. 什么时候应该用 bridge

bridge 更适合这些场景：

1. 你要使用 runtime 原生 built-in tools
2. 你要使用 runtime 原生 skills
3. 你要查看 runtime 当前有哪些 tools / skills / agents
4. 你要看 runtime 事件流
5. 你要做 runtime parity、兼容接入或研究

如果你是在开发新的业务应用，建议优先使用 clean SDK。bridge 更适合作为兼容和运行时接入说明。

## 3. 最基础的 bridge 示例

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

## 4. runtime introspection

bridge 可以查看当前 runtime 表面：

```ts
const runtime = await sdk.getRuntimeInfo();
console.log(runtime.tools);
console.log(runtime.skills);
console.log(runtime.agents);
```

仓库示例：

- [examples/actoviq-introspection.ts](../../examples/actoviq-introspection.ts)
- [examples/actoviq-bridge-sdk.ts](../../examples/actoviq-bridge-sdk.ts)

## 5. bridge helper

bridge 还支持：

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 6. bridge 事件 helper

bridge 提供了事件解析 helper：

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

下一章：

- [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
