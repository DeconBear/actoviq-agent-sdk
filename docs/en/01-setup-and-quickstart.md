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
    "ACTOVIQ_DEFAULT_MIN_MODEL": "your-fast-model",
    "ACTOVIQ_DEFAULT_MEDIUM_MODEL": "your-balanced-model",
    "ACTOVIQ_DEFAULT_MAX_MODEL": "your-capable-model"
  }
}
```

You can also keep a project-local JSON file and preload it with `loadJsonConfigFile(...)`.

The `min`, `medium`, and `max` names are provider-neutral aliases. `ACTOVIQ_MODEL`
may be an alias or a concrete provider model ID. If it is omitted, the SDK
prefers `medium`, then `max`, then `min`.

### Choosing a provider

The SDK supports two provider protocols. Set `provider` in `createAgentSdk()` (default: `'anthropic'`).

**Anthropic protocol** (default):

```ts
const sdk = await createAgentSdk({
  // provider: 'anthropic' is the default
  baseURL: 'https://api.anthropic.com',
  apiKey: 'sk-ant-xxx',
  model: 'medium',
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

**Important:** `actoviq-react` is a lightweight scrollback REPL. It is **not a full TUI** — there is no alternate screen buffer, no ScrollBox, and no rich terminal rendering. It is intended for quick interaction and debugging. For the full terminal UI, use `actoviq-tui`.

## 5. Terminal UI (TUI)

The package also includes the full Clean SDK terminal UI:

```bash
npx actoviq-tui [work-dir] [options]

# Options
#   --config <path>            Load a specific Actoviq settings JSON file
#   --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)
#   --model <model>            Override the configured model or tier alias
#   --resume <session-id>      Resume a stored Clean SDK session
#   --continue                 Continue the most recently updated session
```

`actoviq-tui` mirrors Claude Code's default terminal interaction pattern while staying fully Clean SDK-owned: transcript output streams into native scrollback, and a redrawable bottom region hosts the status line, a Claude-style prompt bar, slash-command menu, and permission prompts.

Use it when you want a richer terminal experience:

- Live status with spinner, elapsed time, tool count, context estimate, and current tool.
- Multi-line editing with `\` + Enter or Ctrl+J, history navigation, and inline cursor rendering.
- Searchable slash-command menu. `/resume` opens a project-session picker, while `/resume <session-id>` resumes directly.
- `/model` selects a model; `/model config` edits the provider, masked API key, base URL, and model tiers. `/effort` selects the provider reasoning effort.
- `/skills`, `/agents`, `/mcp`, and `/plugins` browse Clean SDK capability catalogs; `/help` searches command usage and `/dream` controls dream runs.
- Mid-run steering: type while the agent is working and press Enter to queue guidance into the next model request.
- Interactive permission prompts when launched with `--permission-mode default`; always-allow rules persist with the session.
- Esc aborts the active run; Ctrl+C clears input or exits on a quick second press.

Both `actoviq-react` and `actoviq-tui` use the same Clean SDK defaults: `~/.actoviq/settings.json`, core tools for the current workspace, `bypassPermissions`, and uncapped tool iterations unless explicitly configured.

When `sessionDirectory` is not set explicitly, sessions are isolated by workspace under `~/.actoviq/projects/<workspace-key>`.

## 6. Run the repository quickstart

```bash
npm run example:actoviq-quickstart
```

Reference:

- [examples/actoviq-quickstart.ts](../../examples/actoviq-quickstart.ts)

## 7. Minimal streaming chat bot

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

## 8. Next steps

Continue to the next chapter to learn about streaming, sessions, and tool use.

Next chapter:

- [02-basic-run-stream-session.md](./02-basic-run-stream-session.md)
