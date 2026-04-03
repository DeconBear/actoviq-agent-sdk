# 03. Tools, Permissions, Skills, and MCP

This chapter is where the SDK starts to feel like a real agent system.

## 1. Tools vs. skills

These two ideas are related, but they are not the same.

- **Tools** do work directly: read files, edit files, search code, open URLs, take screenshots, or delegate tasks.
- **Skills** package a work style: debug systematically, simplify a solution, review release readiness, or fork a reviewer-style pass.

## 2. Tool categories in the clean SDK

The clean SDK can compose several tool sources together.

### Custom local tools

```ts
import { z } from 'zod';
import { tool } from 'actoviq-agent-sdk';

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);
```

### File tools

```ts
import { createActoviqFileTools } from 'actoviq-agent-sdk';

const tools = createActoviqFileTools({ cwd: process.cwd() });
```

Current file tools:

1. `Read`
2. `Write`
3. `Edit`
4. `Glob`
5. `Grep`

### Computer-use tools

Use `createActoviqComputerUseToolkit(...)` when you want browser or desktop-style actions.

Current clean computer-use tools include:

1. `computer_open_url`
2. `computer_type_text`
3. `computer_keypress`
4. `computer_read_clipboard`
5. `computer_write_clipboard`
6. `computer_take_screenshot`
7. `computer_run_workflow`

### Task delegation tool

If you register named agents, the clean SDK can expose a `Task` delegation tool that hands work to another agent.

### MCP tools

MCP servers can add even more tools to the current agent surface.

## 3. How to inspect the clean tool surface

The clean SDK tool catalog is still being expanded, but today the best way to inspect the active tool surface is:

1. look at the tools you passed into `createAgentSdk(...)`
2. look at generated tool groups such as file tools or computer-use tools
3. inspect tool calls on results:

```ts
const result = await sdk.run('Use the provided tools to inspect the workspace.');
console.log(result.toolCalls);
```

## 4. Clean SDK skills

Clean SDK skills now work without bridge mode.

### Bundled skills

Current bundled skills:

1. `debug`
2. `simplify`
3. `batch`
4. `verify`
5. `remember`
6. `stuck`
7. `loop`
8. `update-config`

### Listing skills

```ts
const skills = sdk.skills.listMetadata();
console.log(skills);
```

### Run a skill directly

```ts
const result = await sdk.runSkill(
  'debug',
  'Explain how this project should validate a release safely.',
);
console.log(result.text);
```

### Use a skill handle

```ts
const debugSkill = sdk.skills.use('debug');
console.log(await debugSkill.metadata());
console.log((await debugSkill.run('Investigate why CI might fail.')).text);
```

### Run a skill inside a session

```ts
const session = await sdk.createSession({ title: 'Skill Demo' });
const result = await session.runSkill(
  'remember',
  'Remember that releases should wait for CI and npm pack --dry-run.',
);
console.log(result.text);
```

### Register your own skill

```ts
import { skill } from 'actoviq-agent-sdk';

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

### Forked skill execution

If a skill should run through another named agent:

```ts
const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: 'Review work and report the sharpest findings first.',
    },
  ],
  skills: [
    skill({
      name: 'review-with-reviewer',
      description: 'Fork work to the reviewer agent.',
      context: 'fork',
      agent: 'reviewer',
      prompt: 'You are executing the /review-with-reviewer skill.\\n\\nTask:\\n$ARGUMENTS',
    }),
  ],
});
```

### Skill loading from disk

The clean SDK can load skills from:

1. `~/.actoviq/skills`
2. `<workDir>/.actoviq/skills`
3. `<workDir>/.actoviq/commands`

You can also add:

```ts
const sdk = await createAgentSdk({
  skillDirectories: ['E:/my-skills'],
});
```

## 5. Bridge skills

The bridge SDK still matters when you specifically want runtime-native skills.

Use bridge skills when you want:

1. runtime-native skill discovery
2. runtime-native skill behavior
3. runtime introspection and built-in runtime tools in the same flow

## 6. Permissions, classifier, and approver

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

## 7. MCP

The SDK supports:

1. local MCP servers
2. `stdio` MCP servers
3. `streamable_http` MCP servers

Example:

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
- [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
- [examples/actoviq-introspection.ts](../../examples/actoviq-introspection.ts)

Next chapter:

- [04-agents-swarm-memory-workspace.md](./04-agents-swarm-memory-workspace.md)
