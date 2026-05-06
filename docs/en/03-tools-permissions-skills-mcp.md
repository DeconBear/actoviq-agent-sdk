# 03. Tools, Permissions, Skills, and MCP

This chapter is where the clean SDK starts to feel like a full agent system.

## 1. Tools vs. skills

- **Tools** perform direct actions: read files, edit files, search, take screenshots, or delegate tasks.
- **Skills** package a working style: debug methodically, verify a result, or run a reviewer-style pass.

## 2. Tool categories in the clean SDK

The clean SDK can combine several tool sources in one run:

1. custom local tools created with `tool(...)`
2. file tools from `createActoviqFileTools(...)`
3. computer-use tools from `createActoviqComputerUseToolkit(...)`
4. the clean `Task` delegation tool when named agents are registered
5. MCP tools from local, `stdio`, or `streamable_http` servers

## 3. Inspect the clean tool surface

The clean SDK now has a dedicated tool catalog API:

```ts
const tools = await sdk.tools.listMetadata();
const catalog = await sdk.tools.getCatalog();

console.log(tools);
console.log(catalog.byCategory.file);
console.log(catalog.byCategory.computer);
```

Each tool record includes:

1. `name`
2. `description`
3. `provider`
4. `category`
5. `server`
6. `readOnly`
7. `mutating`

Repository example:

- [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)

## 4. Clean skills

Clean skills work directly through `createAgentSdk(...)`.

### List skills

```ts
console.log(sdk.skills.listMetadata());
```

### Run a skill directly

```ts
const result = await sdk.runSkill(
  'debug',
  'Explain what should be validated before the next release.',
);
console.log(result.text);
```

### Run a skill inside a session

```ts
const session = await sdk.createSession({ title: 'Skill demo' });
const result = await session.runSkill(
  'remember',
  'Remember that releases must wait for CI and npm pack --dry-run.',
);
console.log(result.text);
```

### Add a custom skill

```ts
const sdk = await createAgentSdk({
  skills: [
    skill({
      name: 'release-check',
      description: 'Review release readiness and summarize blockers.',
      prompt: 'You are executing the /release-check skill.\\n\\nTask:\\n$ARGUMENTS',
    }),
  ],
});
```

## 5. Clean dream support

The clean SDK now has a first-class dream API for durable memory consolidation:

```ts
const state = await sdk.dreamState();
console.log(state);

const session = await sdk.createSession({ title: 'Dream demo' });
const dreamResult = await session.dream({
  extraContext: 'Consolidate stable release notes and workflow constraints.',
});

console.log(dreamResult.result?.text);
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

## 6. Clean slash-command replacements

The clean SDK exposes command-style helpers:

```ts
console.log(sdk.slashCommands.listMetadata());

const contextResult = await sdk.slashCommands.run('context');
const toolsResult = await sdk.slashCommands.run('tools');
```

Available clean replacements:

1. `context`
2. `compact`
3. `memory`
4. `dream`
5. `tools`
6. `skills`
7. `agents`

These are backed by typed APIs:

1. `sdk.context.overview(...)`
2. `sdk.context.describe(...)`
3. `sdk.context.compact(sessionId, ...)`
4. `sdk.context.memoryState(...)`
5. `sdk.dream.run(...)`
6. `sdk.context.tools(...)`
7. `sdk.context.skills()`
8. `sdk.context.agents()`

## 7. Permissions, classifier, and approver

### Permission mode

```ts
const sdk = await createAgentSdk({
  permissionMode: 'plan',
});
```

### Permission rules

```ts
const sdk = await createAgentSdk({
  permissions: [
    { toolName: 'Write', behavior: 'deny' },
    { toolName: 'Read', behavior: 'allow' },
  ],
});
```

### Classifier

```ts
const sdk = await createAgentSdk({
  classifier: ({ publicName }) =>
    publicName === 'Write'
      ? { behavior: 'allow', reason: 'Safe write in the current flow.' }
      : undefined,
});
```

### Approver

```ts
const sdk = await createAgentSdk({
  permissions: [{ toolName: 'computer_*', behavior: 'ask' }],
  approver: ({ publicName }) =>
    publicName.startsWith('computer_')
      ? { behavior: 'allow', reason: 'Approved for this run.' }
      : { behavior: 'deny', reason: 'Not approved.' },
});
```

## 8. MCP

The SDK supports:

1. local MCP servers
2. `stdio` MCP servers
3. `streamable_http` MCP servers

```ts
import { createAgentSdk, stdioMcpServer } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk({
  mcpServers: [
    stdioMcpServer({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    }),
  ],
});
```

Repository examples:

- [examples/actoviq-file-tools.ts](../../examples/actoviq-file-tools.ts)
- [examples/actoviq-computer-use.ts](../../examples/actoviq-computer-use.ts)
- [examples/actoviq-dream.ts](../../examples/actoviq-dream.ts)
- [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
- [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)

Next chapter:

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
