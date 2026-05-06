# From Zero to One: Build a Complete Clean Agent Project

This tutorial walks through a full clean-SDK project, not just a quick demo. We stay on `createAgentSdk()` from start to finish.

## What you will build

By the end, you will have a terminal-based agent that:

1. loads a local JSON config
2. keeps multi-turn session history
3. streams responses
4. calls local tools
5. uses clean skills
6. can be pointed at a specific workspace
7. can later grow into MCP, memory, swarm, and computer-use workflows

## 1. Install dependencies

```bash
npm install actoviq-agent-sdk zod
```

## 2. Prepare a config file

Create `agent.settings.json`:

```json
{
  "ACTOVIQ_BASE_URL": "https://your-model-endpoint.example.com/v1",
  "ACTOVIQ_AUTH_TOKEN": "your-token",
  "ACTOVIQ_MODEL": "your-model-name"
}
```

The nested `env` form also works.

## 3. Build the first runnable app

Create `src/app.ts`:

```ts
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { z } from 'zod';
import {
  createAgentSdk,
  createActoviqFileTools,
  loadJsonConfigFile,
  skill,
  tool,
} from 'actoviq-agent-sdk';

const CONFIG_PATH = path.resolve(process.cwd(), 'agent.settings.json');
const WORK_DIR = process.cwd();

await loadJsonConfigFile(CONFIG_PATH);

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

const releaseCheck = skill({
  name: 'release-check',
  description: 'Check release-readiness concerns.',
  prompt: 'You are running the release-check skill.\n\nTask:\n$ARGUMENTS',
  inheritDefaultTools: false,
  inheritDefaultMcpServers: false,
  allowedTools: [],
});

const sdk = await createAgentSdk({
  workDir: WORK_DIR,
  tools: [...createActoviqFileTools({ cwd: WORK_DIR }), addNumbers],
  skills: [releaseCheck],
});

const rl = readline.createInterface({ input, output });
const session = await sdk.createSession({ title: 'My Clean Agent' });

console.log('Agent started. Type exit to quit.');
console.log(`session.id = ${session.id}`);

try {
  while (true) {
    const prompt = (await rl.question('\nYou> ')).trim();
    if (!prompt) continue;
    if (['exit', 'quit', '/exit', ':q'].includes(prompt.toLowerCase())) break;

    if (prompt.startsWith('/skill ')) {
      const args = prompt.slice('/skill '.length).trim();
      const result = await session.runSkill(
        'release-check',
        args || 'Summarize the release checks for this project.',
      );
      console.log(`\nAgent> ${result.text}`);
      continue;
    }

    const stream = session.stream(prompt, {
      systemPrompt: 'You are a clear, reliable, concise engineering assistant.',
    });

    output.write('\nAgent> ');
    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        output.write(event.delta);
      }
    }

    const result = await stream.result;
    output.write('\n');

    if (result.toolCalls.length > 0) {
      console.log('Tools used:', result.toolCalls.map(call => call.name));
    }
  }
} finally {
  rl.close();
  await sdk.close();
}
```

## 4. Run it

```bash
npx tsx src/app.ts
```

Or add a script:

```json
{
  "scripts": {
    "dev": "tsx src/app.ts"
  }
}
```

Then run:

```bash
npm run dev
```

## 5. Add the next layers

After the first version works, expand in this order:

1. more local tools
2. more clean skills
3. session recovery with `sdk.sessions.list()` and `sdk.resumeSession(...)`
4. memory and `session.extractMemory()`
5. swarm teammates
6. workspace isolation

## 6. Where to look next

Useful repository examples:

1. [examples/quickstart.ts](../../examples/quickstart.ts)
2. [examples/actoviq-skills.ts](../../examples/actoviq-skills.ts)
3. [examples/actoviq-agent-helpers.ts](../../examples/actoviq-agent-helpers.ts)
4. [examples/actoviq-swarm.ts](../../examples/actoviq-swarm.ts)
