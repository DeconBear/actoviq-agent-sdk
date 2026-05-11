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

### Choosing a provider

The SDK supports two provider protocols. Set `provider` in `createAgentSdk()` (default: `'anthropic'`).

**Anthropic protocol** (default):

```ts
const sdk = await createAgentSdk({
  // provider: 'anthropic' is the default
  baseURL: 'https://api.anthropic.com',
  apiKey: 'sk-ant-xxx',
  model: 'claude-sonnet-4-6',
});
```

**OpenAI protocol** — works with OpenAI, DeepSeek, vLLM, and any OpenAI-compatible API:

```ts
const sdk = await createAgentSdk({
  provider: 'openai',
  baseURL: 'https://api.openai.com',        // or https://api.deepseek.com
  apiKey: 'sk-xxx',
  model: 'gpt-4o',                          // or deepseek-chat
});
```

The provider can also be set via environment variable or JSON config:

```json
{
  "env": {
    "ACTOVIQ_PROVIDER": "openai",
    "ACTOVIQ_API_KEY": "sk-xxx",
    "ACTOVIQ_BASE_URL": "https://api.deepseek.com",
    "ACTOVIQ_MODEL": "deepseek-chat"
  }
}
```

The SDK automatically handles protocol translation. All APIs (`sdk.run()`, `session.send()`, `workflow`, `parallel()`, etc.) work identically regardless of which provider you choose.

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

## 4. CLI REPL (scrollback-mode)

The package includes a built-in interactive REPL. After installing, you can start it directly:

```bash
npx actoviq-react [work-dir]
```

This launches a readline-based agent in the main terminal buffer:
- Type messages directly and see streaming responses
- Use `/` slash commands: `/help`, `/clear`, `/compact`, `/memory`, `/model`, `/tools`, `/dream`, `/exit`
- Tab completion for commands, ↑↓ for history
- Ctrl+C once to abort the current request, twice to exit

**Important:** `actoviq-react` is a lightweight scrollback REPL. It is **not a full TUI** — there is no alternate screen buffer, no ScrollBox, and no rich terminal rendering. It is intended for quick interaction and debugging. For programmatic use, see the SDK API below.

## 5. Run the repository quickstart

```bash
npm run example:actoviq-quickstart
```

Reference:

- [examples/actoviq-quickstart.ts](../../examples/actoviq-quickstart.ts)

## 6. Minimal streaming chat bot

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

## 7. Next steps

Continue to the next chapter to learn about streaming, sessions, and tool use.

Next chapter:

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
