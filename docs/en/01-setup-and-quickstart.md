# 01. Setup and Quick Start

This chapter gets you from zero to a working SDK call as quickly as possible.

## 1. Install

Inside your project:

```bash
npm install actoviq-agent-sdk zod
```

If you are working inside this repository, install dependencies once with:

```bash
npm install
```

## 2. Prepare your JSON config

The easiest local setup is:

```text
~/.actoviq/settings.json
```

Example:

```json
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "your-token",
    "ACTOVIQ_BASE_URL": "https://api.example.com/actoviq",
    "ACTOVIQ_DEFAULT_SONNET_MODEL": "your-model"
  }
}
```

You can also keep a project-local JSON file and preload it with `loadJsonConfigFile(...)`.

## 3. Your first SDK call

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

try {
  const result = await sdk.run('Introduce yourself in one short sentence.');
  console.log(result.text);
} finally {
  await sdk.close();
}
```

## 4. Run the repository quickstart

```bash
npm run example:quickstart
```

Reference:

- [examples/quickstart.ts](../../examples/quickstart.ts)

## 5. Minimal streaming chat bot

This is the smallest useful streaming chat loop. Once you connect your own API JSON, you can use it as a simple terminal chat bot.

```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  createAgentSdk,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

await loadJsonConfigFile('E:/configs/my-agent-config.json');

const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Simple Chat Bot' });
const rl = readline.createInterface({ input, output });

try {
  while (true) {
    const message = (await rl.question('You> ')).trim();
    if (!message || message === 'exit' || message === 'quit') {
      break;
    }

    const stream = session.stream(message);
    process.stdout.write('Bot> ');

    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        process.stdout.write(event.delta);
      }
    }

    const result = await stream.result;
    process.stdout.write(`\n[session=${session.id} stop=${result.stopReason}]\n\n`);
  }
} finally {
  rl.close();
  await sdk.close();
}
```

## 6. Ready-to-run interactive program

If you want a fuller program with tool calls and a built-in REPL loop, use:

- [examples/actoviq-interactive-agent.ts](../../examples/actoviq-interactive-agent.ts)

Run it with:

```bash
npm run example:actoviq-interactive-agent
```

That example is already a usable interactive program with:

- streaming output
- tool access
- an infinite loop until you exit
- configurable workspace path
- configurable JSON config path

Next chapter:

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
