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

## 1.2. Six providers (claude / pi / codex / codewhale / reasonix / crush)

| Provider | `directCliProvider` | Binary | Entry | Protocol |
|---|---|---|---|---|
| Claude Code (default) | `'claude'` | `claude` | `claude -p --output-format stream-json …` | stream-json |
| pi | `'pi'` | `pi` | `pi -p --mode json …` | JSONL |
| codex | `'codex'` | `codex` | `codex exec --json …` | JSONL |
| CodeWhale | `'codewhale'` | `codewhale` | `codewhale exec --auto --output-format stream-json …` | stream-json (same as claude) |
| Reasonix | `'reasonix'` | `reasonix` | `reasonix run [--model] [--effort] <task>` | plain text |
| Crush | `'crush'` | `crush` | `crush run [--model] [--session] <prompt>` | plain text |

```ts
const sdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'codewhale',   // or 'reasonix', 'crush', …
  workDir: process.cwd(),
});
```

**Credentials:** claude → `ANTHROPIC_*`; codewhale → ANTHROPIC_*/DEEPSEEK_*;
reasonix → DEEPSEEK_*; crush → OPENAI_*/ANTHROPIC_*.
Put keys in `~/.actoviq/settings.json`'s `env` block.

**Introspection degrades** for pi/codex/reasonix/crush (no tools/skills catalog in
startup events). run / stream / session lifecycle is aligned across all six.

## 1.3. Env overrides & auto-detection

### `ACTOVIQ_<PROVIDER>_PATH`

Overrides the auto-detected binary path when the CLI is not on `PATH`:

```bash
export ACTOVIQ_CLAUDE_PATH=/opt/claude-code/bin/claude
export ACTOVIQ_CODEX_PATH=/custom/codex
export ACTOVIQ_REASONIX_PATH=~/bin/reasonix
# … same pattern for every provider: ACTOVIQ_<ID>_PATH
```

These go into `~/.actoviq/settings.json`'s `env` block (or the top level) —
mirrors the `ACTOVIQ_BASH_PATH` convention.

### `bridge` settings block

```jsonc
// ~/.actoviq/settings.json
{
  "bridge": {
    "defaultProvider": "codewhale",
    "providers": {
      "crush": { "path": "/opt/crush" }  // per-provider path override
    }
  }
}
```

Resolution order (all in-memory, no file I/O during a run):
`executable` option → `ACTOVIQ_<ID>_PATH` env → `bridge.providers[id].path` → `PATH`.

### `detectBridgeProviders()`

```ts
import { detectBridgeProviders } from 'actoviq-agent-sdk';

const providers = await detectBridgeProviders();
// [{ id:'claude', available:true, path:'/…/claude.cmd', version:'2.1.186', displayName:'…' }, …]
```

Returns one entry per registered provider, best-effort `--version` probe included.
Used by the CLI `/bridge` wizard, TUI `/bridge setup`, and GUI Settings → Bridge panel.

## 1.4. Troubleshooting — no runtime detected?

1. **Install the CLI** (`npm i -g @anthropic-ai/claude-code`, `npm i -g codewhale`, …)
   and restart your shell so it's on `PATH`.
2. **Run `npx actoviq-interactive-agent`** and type `/bridge` — the wizard shows
   detected providers and lets you pick a default.
3. **Set `ACTOVIQ_<ID>_PATH`** (see 1.3) if the binary is installed but not on `PATH`
   (common in CI, IDE launchers that don't inherit shell profiles).
4. **Ask Claude Code to help:** paste the output of `/providers` (or the GUI's
   "Detect runtimes" button) into Claude Code and let it guide the install.

Implementation: `src/parity/bridgeProviders.ts` (per-provider argv/env/normalizer),
`src/cli/bridge-interactive-agent.ts` (/bridge wizard), `src/tui/actoviqTui.ts`
(/bridge run/switch/setup), `src/gui/actoviqGui.ts` (bridge panel + run).

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
