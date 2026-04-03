# 05. Bridge Runtime：什么时候该用 `createActoviqBridgeSdk`

这一章讲 bridge 路线是什么，以及什么时候适合用它。

## 1. bridge 是什么？

bridge 可以理解成一层兼容适配层，它暴露的是偏 runtime 风格的执行路径。

入口：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. 什么时候该用 bridge？

bridge 更适合这些场景：

1. 你要使用 runtime 原生 built-in tools
2. 你要使用 runtime 原生 skills
3. 你要查看 runtime 当前有哪些 tools / skills / agents
4. 你要看 runtime 事件流
5. 你要研究 runtime parity 或兼容行为

如果你只是做自己的业务 agent，通常优先用 clean SDK。

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

## 5. bridge skill helper

```ts
const debugSkill = sdk.useSkill('debug');
const result = await debugSkill.run('给我一个简短的调试检查清单。');
```

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

## 7. 交互式 bridge 示例

仓库里已经有一个可直接使用的示例：

- [examples/actoviq-interactive-agent.ts](../../examples/actoviq-interactive-agent.ts)

运行方式：

```bash
npm run example:actoviq-interactive-agent
```

下一章：

- [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
