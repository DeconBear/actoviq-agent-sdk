# 05. Bridge Runtime Compatibility

This chapter explains the compatibility bridge path and when it is still useful.

## 1. Prerequisites — linking a runtime bundle

The actoviq-bridge-sdk requires a runtime bundle from a third-party agent runtime (e.g. Claude Code). This file is **not included** in the actoviq-agent-sdk package.

If you have Claude Code installed, link its runtime bundle:

```bash
# Claude Code is published as @anthropic-ai/claude-code on npm

# macOS / Linux (npm global)
npx actoviq-link-runtime /usr/local/lib/node_modules/@anthropic-ai/claude-code

# macOS / Linux (nvm)
npx actoviq-link-runtime ~/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code

# Windows
npx actoviq-link-runtime %AppData%\npm\node_modules\@anthropic-ai\claude-code

# Or let npm find it for you:
npx actoviq-link-runtime "$(npm root -g)/@anthropic-ai/claude-code"
```

Alternatively, set the environment variable:

```bash
export ACTOVIQ_RUNTIME_BUNDLE="/path/to/runtime-bundle"
```

Without this bundle, actoviq-bridge-sdk features will not work.

> **Note (native-exe Claude Code):** newer `@anthropic-ai/claude-code` ships
> as a native executable (`bin/claude.exe`) with **no** `runtime.bundle.br`
> inside the package, so `actoviq-link-runtime` cannot link it. Use the
> **directCli mode** below instead — it spawns your local `claude` binary
> directly and needs no bundle.

## 1.1. Reusing the local Claude Code directly (directCli mode)

If Claude Code is installed on your PATH, you can skip the bundle and have
the bridge spawn your local `claude` directly:

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';

const sdk = await createActoviqBridgeSdk({
  directCli: true,           // spawn the local claude, bypassing runtime.bundle.br + Bun
  // executable: 'claude',   // optional; defaults to `claude` found on PATH
  workDir: process.cwd(),
});

const result = await sdk.run('Summarize the current directory in one sentence.');
```

This works like multica's "shell out by name": the bridge locates `claude` on
PATH, spawns it with `-p --output-format stream-json --verbose …`, and parses
the same `system/assistant/result` event stream as the bundle path — only the
child process is your installed official claude instead of the vendored bundle.

**Provider isolation (key capability):** directCli mode **fully preserves**
actoviq's env-injection chain (`~/.actoviq/settings.json` → `ANTHROPIC_BASE_URL`
/ `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`, see `anthropicEnvMapping.ts`). So
you can keep your **interactive `claude` on Claude official while the bridge's
`claude` child redirects to DeepSeek or another provider** — the child's
`ANTHROPIC_*` env overrides `~/.claude/settings.json`, and the two never
interfere. Example:

```json
// ~/.actoviq/settings.json (affects only the bridge child, not interactive claude)
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "sk-...",
    "ACTOVIQ_BASE_URL": "https://api.deepseek.com/anthropic",
    "ACTOVIQ_DEFAULT_MAX_MODEL": "deepseek-v4-pro"
  }
}
```

> Tip: if your current shell has `ANTHROPIC_API_KEY` set to Claude official and
> settings.json provides no credential, the child falls back to that value —
> configure the provider fully.

## 1.2. Multiple providers: claude / pi / codex

directCli mode is not limited to Claude Code. `directCliProvider` selects which
local CLI to spawn. All three share the same spawn + line-by-line JSONL pipeline;
only their wire protocols differ — a normalizer translates each provider's native
events into the unified `system/assistant/result` trio.

| Provider | `directCliProvider` | Local binary | Entry | Protocol |
|---|---|---|---|---|
| Claude Code (default) | `'claude'` | `claude` | `claude -p …` | stream-json |
| pi | `'pi'` | `pi` | `pi -p --mode json …` | JSONL (session/message_update/agent_end) |
| codex | `'codex'` | `codex` | `codex exec --json …` | JSONL (thread.started/item.*/turn.completed) |

```ts
// reuse the local pi CLI
const piSdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'pi',
  workDir: process.cwd(),
});

// reuse the local codex CLI
const codexSdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'codex',
  workDir: process.cwd(),
});
```

**Credentials differ per provider:** claude uses `ANTHROPIC_*` (above); pi/codex read
their own env vars (`OPENAI_API_KEY`, etc.). Put the provider-specific key directly in the
`env` block of `~/.actoviq/settings.json` — pi/codex do not remap `ANTHROPIC_*`.

**Introspection degrades:** pi and codex startup events carry no
tools/skills/agents/slash_commands catalog (claude does). So `getRuntimeInfo()` /
`listSkills()` / `getRuntimeCatalog()` return limited data (empty tools/skills) for
pi/codex. run / stream / session / createSession / continueMostRecent / fork are fully
aligned across all three.

See `src/parity/bridgeProviders.ts` for the per-provider `RuntimeProvider` (argv
construction, env injection, event normalization).

## 2. What bridge means

The actoviq-bridge-sdk is a compatibility layer that exposes a runtime-oriented execution path from the current package.

Use:

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 3. When to use bridge

Bridge is most useful when you want:

1. runtime-native built-in tools
2. runtime-native skills
3. runtime-native agents and subagents
4. runtime introspection
5. native runtime sessions and event streams

If you are building a new application, prefer the Hadamard SDK first. Treat bridge as compatibility and runtime-integration guidance.

## 4. Basic bridge example

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

## 5. Runtime introspection

Bridge can list the current runtime surface:

```ts
const runtime = await sdk.getRuntimeInfo();
console.log(runtime.tools);
console.log(runtime.skills);
console.log(runtime.agents);
```

Repository examples:

- [examples/bridge-introspection.ts](../../examples/bridge-introspection.ts)
- [examples/bridge-sdk.ts](../../examples/bridge-sdk.ts)

## 6. Bridge helpers

Bridge also supports:

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 7. Event helpers

Bridge exports helpers for parsing runtime events:

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

Next chapter:

- [05-testing-troubleshooting-cheatsheet.md](./05-testing-troubleshooting-cheatsheet.md)
