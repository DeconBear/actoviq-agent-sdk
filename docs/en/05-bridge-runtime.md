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

**Authentication modes:** `authSource: 'native'` is the default. Actoviq starts
the CLI with its normal home/config environment intact, so the child reuses the
CLI's existing OAuth/login or native configuration. Actoviq does not read or
copy credential-store values, and it does not map Actoviq API credentials into
the child in this mode. Provider credentials already present in the parent shell
environment remain available, just as when the CLI is launched manually;
therefore `native` means "use the CLI's normal authentication environment", not
"force OAuth instead of an environment API key".

Use `authSource: 'apiKey'` for an isolated override:

```ts
const sdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'claude',
  authSource: 'apiKey',
  apiKey: process.env.CHILD_ONLY_ANTHROPIC_KEY,
  baseURL: 'https://provider.example/anthropic',
});
```

The override is passed only to that child process, redacted from retained
events/errors, and never written into the selected CLI's credential store. If
you save the profile, the value is still stored in Actoviq's
`bridge-configs.json` (mode `0600` on POSIX); "child-only" describes runtime
injection, not an in-memory-only secret.

For Pi, CodeWhale, Reasonix, and Crush, API-key mode separates transient
credential/config files from durable session state. Transient homes are removed
when the managed client closes; resumable state is kept under
`~/.actoviq/external-cli-profiles/<runtime>/<profile-hash>/`. A saved config's
`profileName` provides the stable identity, and neither the raw key nor a hash of
the key is used in the path. This prevents the user's native credential store
from overriding the selected key while preserving same-profile history across
restarts. `credentialProvider` (or a provider prefix in `model`) selects the
provider-specific variable. Multi-provider Crush model/key overrides require an
explicit provider and fail closed when it cannot be inferred.

## 1.2. Six providers (claude / pi / codex / codewhale / reasonix / crush)

The SDK adapter registry, GUI, TUI, and external-runtime manager support all six
providers below. Every runtime can run in the foreground or background, stream
normalized events, be interrupted, and have its supervised process tree
reclaimed. History and exact resume use each CLI's native session surface rather
than replaying an Actoviq transcript into a new API conversation.

| Provider | `directCliProvider` | Binary | Entry | Protocol |
|---|---|---|---|---|
| Claude Code (default) | `'claude'` | `claude` | `claude -p --output-format stream-json …` | stream-json |
| Pi | `'pi'` | `pi` | `pi --mode rpc …` (prompt over stdin) | JSON-RPC/JSONL |
| codex | `'codex'` | `codex` | `codex exec --json …` | JSONL |
| CodeWhale | `'codewhale'` | `codewhale` | `codewhale exec --output-format stream-json … -- <prompt>` | CodeWhale stream-json |
| Reasonix | `'reasonix'` | `reasonix` | `reasonix acp [--model …]` (prompt over stdin) | ACP JSON-RPC |
| Crush | `'crush'` | `crush` | `crush server --host <private-socket>` | HTTP + SSE over a local socket |

```ts
const sdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'codewhale',   // or 'reasonix', 'crush', …
  workDir: process.cwd(),
});
```

### Managed capability details

| Runtime | Model and permission control | Native session/history behavior |
|---|---|---|
| Pi | `provider/model`, thinking effort, and explicit tool allow/exclude lists are sent to RPC mode. Default/plan are read-only, `acceptEdits` adds edit/write, and only `bypassPermissions` exposes the full native tool set. `trustProjectResources` defaults to false and controls Pi's separate project-trust prompt; it does not grant tool permissions. | Exact IDs use Pi's native session flags. The history reader understands v3 tree JSONL and renders only the active parent-linked branch. |
| CodeWhale | Model and tool lists use native `exec` flags. Default/plan/dontAsk are restricted to a known read-only allowlist. The 0.8.65 CLI cannot represent `acceptEdits` safely, so Actoviq rejects that mode; `--auto` is emitted only for explicit `bypassPermissions`. | Stream metadata contains only a redacted fingerprint. Actoviq correlates it by fingerprint, cwd, and run time only when one native SavedSession matches; it never guesses between ambiguous sessions. Exact `--resume=<id>` and bounded SavedSession history/tool records then use that ID. |
| Reasonix | The ACP adapter normalizes message, thought, tool, result, permission, and completion records. Model is passed at startup; effort/budget are changed only when the agent advertises matching ACP config options. Permission requests fail closed unless the selected mode explicitly allows them. | Actoviq keeps one ACP child and native session alive for consecutive turns, serializes concurrent prompts, and cancels through `session/cancel`. Exact cross-process resume is used only when the agent advertises `session/load`; Reasonix 0.53 advertises `loadSession: false`, so its persisted transcript remains inspectable but a restart-time resume returns an explicit unsupported-capability error instead of starting a new conversation. Unqualified "continue latest" is rejected. |
| Crush | Actoviq configures provider/key/base URL/model through the server's workspace endpoints and maps permission requests deterministically (`acceptEdits` allows edit/write/multiedit for the session; default denies; bypass allows). Native model selection is workspace-scoped; isolated API-key settings are profile-global and never mutate the user's native config. | Runs use a fresh private Unix-domain socket or Windows named pipe, never a TCP listener. Exact resume verifies that the server returned the requested session ID. History uses bounded `crush session list/show --json` commands for native and managed-profile stores; the GUI/TUI labels their source separately. Native fork and unqualified "continue latest" are not exposed. |

Reasonix and Crush reject bridge options that their managed protocols cannot
enforce (for example system-prompt/tool filters or turn limits, and Crush
effort/budget). They never accept those options and silently run with broader or
different behavior.

**Authentication status is intentionally conservative.** CodeWhale exposes an
auth status command. Pi only exposes an offline model-catalog probe, so Actoviq
reports its credential state as `unknown`; catalog availability is not treated
as proof of a login or API key. Crush's model probe can report configured model
state but is not proof of a particular OAuth identity. Reasonix currently has no
non-interactive auth status command, so the UI reports `unknown` and lets the ACP
run be the source of truth.

**Crush project config is trusted input.** In both native and isolated API-key
mode, Actoviq refuses to start when `crush.json` or `.crush.json` exists in the
cwd or an ancestor unless `trustProjectResources: true` is set explicitly. This
is separate from the tool permission mode.

**Version behavior is capability-based, not silently downgraded.** Provider
detection records a best-effort CLI version but does not pretend an older binary
has newer protocol features. Pi requires RPC mode and v3 history for full
history reconstruction; CodeWhale is mapped to the 0.8.65 stream/session
behavior above; Reasonix exact resume requires advertised ACP load support; and
Crush requires the `server` plus v1 workspace/session/config routes. Missing
required protocol operations fail closed rather than falling back to an
auto-approved one-shot command.

**Introspection still varies:** these adapters normalize live tool events and
history, but a CLI that does not publish a startup tools/skills catalog will
report an empty catalog. Managed execution does not imply that every runtime
publishes Claude Code's complete introspection surface.

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
Used by the CLI `/bridge` wizard, the TUI `/bridge` control board, and GUI Settings → Bridge panel.

### TUI runtime switching

In the TUI, `/bridge` opens a control board of saved connection configs. Selecting
one activates it as the active runtime. A `Direct API` config injects its model
client into the Hadamard session in-process. An `External CLI` config launches
the selected Claude Code, Codex, Pi, CodeWhale, Reasonix, or Crush executable,
streams its native events, and persists the native session binding per Actoviq
chat/config/workspace when the selected authentication mode preserves the CLI's
session store. `/resume` therefore does not cross-wire native-mode CLI
conversations. `/bridge background`,
`/bridge runs`, and `/bridge stop` control background work; `/bridge history
[native-id]` inspects native transcripts and `/bridge resume <native-id>` selects
a validated same-runtime, same-workspace conversation for the next turn.
`/bridge off` returns to the SDK default without making active background runs
unmanageable.

### Named bridge configs

`/bridge config` opens a management screen: **Add config** (or **Edit**/**Remove**
an existing one) drops you into a single-page **config editor** that shows every
field at once — **name**, **execution mode**, **runtime/provider**, **authentication
source**, optional **credential provider**, **apiKey/baseURL**, **model**, and
**project-resource trust** — with each field's current value. You can edit any field in any order
(e.g. set the key, then go back and change the name), then **Save** to commit or
**Cancel** to discard. Saved configs persist in `~/.actoviq/bridge-configs.json`.
Each Direct API config is a complete preset — e.g. `deepseek-claude` (provider `claude`,
`ANTHROPIC_BASE_URL=https://api.deepseek.com`, `ANTHROPIC_API_KEY=…`,
`model=deepseek-chat`) — so you can keep several backend
profiles and switch by name.

After that, `/bridge` lists your **saved configs**; selecting one (or
`/bridge switch <name>`) activates that runtime. Direct API credentials stay in
the in-process provider path. External CLI key overrides are child-only, while
native mode leaves the CLI's own authentication/configuration in control.
`/bridge off` returns to the in-process SDK. Editing an active config immediately
reactivates it; removing an active config disables bridge mode.

Provider is `'anthropic'` (Anthropic-compatible: Claude, DeepSeek, vLLM, …) or
`'openai'` (OpenAI-compatible: Qwen, GPT, vLLM, …). The config's provider/apiKey/
baseURL/model are passed directly to the SDK — no env vars, no credential mapping.
Implementation: `src/parity/bridgeConfigs.ts`, `src/tui/actoviqTui.ts`.

## 1.4. Troubleshooting — no runtime detected?

1. **Install the CLI** (`npm i -g @anthropic-ai/claude-code`, `npm i -g codewhale`, …)
   and restart your shell so it's on `PATH`.
2. **Run `npx actoviq-interactive-agent`** and type `/bridge` — the wizard shows
   detected providers and lets you pick a default.
3. **Set `ACTOVIQ_<ID>_PATH`** (see 1.3) if the binary is installed but not on `PATH`
   (common in CI, IDE launchers that don't inherit shell profiles).
4. **Ask Claude Code to help:** paste the output of `/providers` (or the GUI's
   "Detect runtimes" button) into Claude Code and let it guide the install.

Implementation: `src/parity/bridgeProviders.ts` (per-provider argv/env/normalizer +
`BRIDGE_PROVIDER_CREDENTIALS` readiness hints), `src/cli/bridge-interactive-agent.ts`
(/bridge wizard), `src/tui/actoviqTui.ts` (TUI `/bridge` control board — one-tap
provider activation, per-provider model, credential hints, and live run status; the
`run`/`background`/`runs`/`stop`/`history`/`resume`/`switch`/`model`/`setup`/`off`/`help`
sub-commands autocomplete), `src/gui/actoviqGui.ts` (loopback-only bridge panel,
background controls, and native history browser).

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
