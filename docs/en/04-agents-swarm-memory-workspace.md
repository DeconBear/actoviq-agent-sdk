# 04. Agents, Swarm, Memory, and Workspace

This chapter covers the higher-level workflow features in the clean SDK.

## 1. Named agents

Register reusable agent roles:

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: 'Review work and report the sharpest findings first.',
      systemPrompt:
        'You are a careful reviewer. Prioritize bugs, regressions, and missing verification.',
    },
  ],
});
```

Run directly through that role:

```ts
const result = await sdk.runWithAgent(
  'reviewer',
  'Review this repository as if you were preparing a release.',
);
```

## 2. Task delegation

If named agents are registered, the clean SDK can delegate work through `Task` and the agent helpers.

Useful entry points:

1. `sdk.createTaskTool()`
2. `sdk.runWithAgent(...)`
3. `sdk.createAgentSession(...)`

## 3. Swarm teammates and side sessions

Use swarm helpers when you want a leader plus teammate pattern:

```ts
const team = sdk.swarm.createTeam({
  name: 'release-team',
  leader: 'lead',
  continuous: true,
});
```

Useful operations:

1. `spawn(...)`
2. `message(...)`
3. `continueFromMailbox(...)`
4. `reenter(...)`
5. `runBackground(...)`
6. `transcript(...)`
7. `waitForIdle()`

You can now also apply team-level runtime context:

```ts
team.setRuntimeContext({
  permissions: [{ toolName: 'write_note', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName === 'write_note'
      ? { behavior: 'allow', reason: 'Approved for teammate work.' }
      : { behavior: 'deny', reason: 'Unexpected tool.' },
});
```

Repository example:

- [examples/actoviq-swarm.ts](../../examples/actoviq-swarm.ts)

## 4. Workspace helpers

You can create isolated directories before starting an agent session.

Available helpers:

1. `createWorkspace(...)`
2. `createTempWorkspace(...)`
3. `createGitWorktreeWorkspace(...)`

```ts
const workspace = await createTempWorkspace({
  prefix: 'actoviq-demo-',
  copyFrom: './examples',
});

const sdk = await createAgentSdk({
  workDir: workspace.path,
});
```

## 5. Memory and session memory

The SDK provides:

1. relevant memory selection
2. session-memory prompt and summary helpers
3. compact-state inspection
4. automatic session-memory extraction once a session is large enough

Main APIs:

```ts
const memory = sdk.memory;
console.log(await memory.findRelevantMemories('how should I release this package?'));
```

At session level:

```ts
const extraction = await session.extractMemory();
const state = await session.compactState({
  includeSessionMemory: true,
  includeSummaryMessage: true,
});
```

Repository examples:

- [examples/actoviq-memory.ts](../../examples/actoviq-memory.ts)
- [examples/actoviq-session-memory.ts](../../examples/actoviq-session-memory.ts)

## 6. Dream

Dream is the clean SDK's reflective memory-consolidation pass over recent sessions.

```ts
const state = await sdk.dreamState();
console.log(state);

const session = await sdk.createSession({ title: 'Dream demo' });
const result = await session.dream({
  extraContext: 'Consolidate stable release workflow notes and recurring project facts.',
});

console.log(result.result?.text);
console.log(result.touchedFiles);
```

Auto-dream:

```ts
await sdk.memory.updateSettings({ autoDreamEnabled: true });
await sdk.maybeAutoDream({
  currentSessionId: session.id,
  background: true,
});
```

Repository example:

- [examples/actoviq-dream.ts](../../examples/actoviq-dream.ts)

## 7. Compact

The clean SDK supports:

1. automatic compact
2. reactive compact
3. API-oriented microcompact shaping
4. persisted compact history and continuity metadata

This matters most in long-running sessions and multi-turn task flows.

Next chapter:

- [05-bridge-runtime.md](./05-bridge-runtime.md)
