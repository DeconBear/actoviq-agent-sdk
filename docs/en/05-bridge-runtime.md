# 05. Bridge Runtime Compatibility

This chapter explains the compatibility bridge path and when it is still useful.

## 1. What bridge means

The bridge SDK is a compatibility layer that exposes a runtime-oriented execution path from the current package.

Use:

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. When to use bridge

Bridge is most useful when you want:

1. runtime-native built-in tools
2. runtime-native skills
3. runtime-native agents and subagents
4. runtime introspection
5. native runtime sessions and event streams

If you are building a new application, prefer the clean SDK first. Treat bridge as compatibility and runtime-integration guidance.

## 3. Basic bridge example

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

const result = await sdk.run('Inspect the examples directory and summarize quickstart.ts.');

console.log(result.text);
console.log(result.events.length);
```

## 4. Runtime introspection

Bridge can list the current runtime surface:

```ts
const runtime = await sdk.getRuntimeInfo();
console.log(runtime.tools);
console.log(runtime.skills);
console.log(runtime.agents);
```

Repository examples:

- [examples/actoviq-introspection.ts](../../examples/actoviq-introspection.ts)
- [examples/actoviq-bridge-sdk.ts](../../examples/actoviq-bridge-sdk.ts)

## 5. Bridge helpers

Bridge also supports:

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 6. Event helpers

Bridge exports helpers for parsing runtime events:

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

Next chapter:

- [06-testing-troubleshooting-cheatsheet.md](./06-testing-troubleshooting-cheatsheet.md)
