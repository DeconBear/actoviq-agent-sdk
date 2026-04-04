# 05. Bridge Runtime 兼容说明

这一章解释什么是 bridge，以及什么时候才需要用它。

## 1. bridge 是什么

bridge 可以理解成一层兼容适配层。它暴露的是更偏 runtime 风格的执行路径。

入口：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. 什么情况下才需要 bridge

更适合用 bridge 的场景：

1. 你要研究现有 runtime 的行为
2. 你要查看 runtime 当前有哪些 tools / skills / agents
3. 你要分析 runtime 事件流
4. 你要做兼容层、迁移层、对照测试

如果你是在开发一个新业务项目，通常优先使用 clean SDK：

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

## 4. runtime introspection

bridge 可以查看当前 runtime 暴露出来的能力：

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

bridge 侧还支持：

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 6. bridge 事件 helper

如果你要分析 runtime 输出的事件流，可以用：

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

下一章：

- [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
