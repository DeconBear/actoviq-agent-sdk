# 18 — Bridge SDK & Parity

## Architecture

The Bridge SDK provides a compatibility layer that wraps a third-party agent
runtime (Claude Code) behind the same API surface as Hadamard SDK. This enables
direct behavioral comparison.

Location: `src/parity/*`

### Two Bridge Wrappers

| Wrapper | Entry | Purpose |
|---|---|---|
| `actoviqBridgeSdk` | `createActoviqBridgeSdk()` | Direct bridge: spawns the runtime in **bundle mode** (`bun vendor/actoviq-runtime/cli.js`) or **directCli mode** (the local `claude` on PATH; no bundle/Bun) |
| `actoviqCleanBridgeCompatSdk` | `createActoviqCleanBridgeSdk()` | Compatibility bridge: Hadamard-like API over bridge runtime |

## Module Design

### Files

| File | Role |
|---|---|
| `parity/actoviqBridgeSdk.ts` | Main bridge SDK client |
| `parity/actoviqCleanBridgeCompatSdk.ts` | Compatibility wrapper with Hadamard API shape |
| `parity/actoviqBridgeEvents.ts` | Bridge event parsing & extraction |
| `parity/actoviqTranscripts.ts` | Session transcript reading |

### Bridge SDK Flow

```
createActoviqBridgeSdk()
    │
    ├── directCli: false (default) ── bundle mode
    │     ├── Verify runtime bundle exists (vendor/actoviq-runtime/cli.js)
    │     └── Verify bun is installed
    │
    ├── directCli: true ── directCli mode
    │     └── Resolve local `claude` on PATH (or options.executable); no bundle/Bun
    │
    └── ActoviqBridgeSdkClient (directCli flag selects the spawn form)
        ├── createSession() → ActoviqBridgeSession
        ├── run(prompt) → spawn child process
        │   ├── bundle:    `bun cli.js -p <prompt> --output-format stream-json …`
        │   ├── directCli: `claude -p <prompt> --output-format stream-json …`
        │   ├── Inject ANTHROPIC_* env (settings.json → child) — both modes
        │   ├── Stream: stdout (stream-json events)
        │   └── Parse: tool calls, results, final output
        └── close()
```

### `actoviqCleanBridgeCompatSdk`

Wraps the bridge runtime behind an API surface that mirrors Hadamard SDK:

```typescript
class ActoviqCleanBridgeSdkClient {
  // Same shape as ActoviqAgentClient's public API:
  readonly sessions: ActoviqCleanBridgeSessionsApi;
  readonly agents: ActoviqCleanBridgeAgentsApi;
  readonly skills: ActoviqCleanBridgeSkillsApi;
  readonly tools: ActoviqCleanBridgeToolsApi;
  // ...

  async run(prompt: string): Promise<AgentRunResult> {
    // Translate to bridge format → execute → translate back
  }
}
```

### Event Extraction

`src/parity/actoviqBridgeEvents.ts` provides parsers for bridge runtime output:

```typescript
function extractActoviqBridgeToolRequests(output: string): ToolRequest[] { /* ... */ }
function extractActoviqBridgeToolResults(output: string): ToolResult[] { /* ... */ }
function extractActoviqBridgeTaskInvocations(output: string): TaskInvocation[] { /* ... */ }
function getActoviqBridgeTextDelta(output: string): string { /* ... */ }
function analyzeActoviqBridgeEvents(output: string): BridgeEventAnalysis { /* ... */ }
```

## Code Details

### Execution Modes: Bundle vs directCli

`createActoviqBridgeSdk()` spawns the runtime in one of two modes, selected by
the `directCli` option. Bundle mode speaks Claude Code's `stream-json` protocol;
directCli mode supports multiple providers (`directCliProvider`), each with its
own wire protocol but the same env-injection seam, so provider isolation works
identically.

| Mode | `directCli` | Spawned process | Needs |
|---|---|---|---|
| Bundle (default) | `false` | `bun vendor/actoviq-runtime/cli.js -p …` | Bun + `runtime.bundle.br` (linked via `actoviq-link-runtime`) |
| directCli | `true` | `claude -p …` (resolved on PATH, or `executable`) | A local `claude` on PATH — no bundle, no Bun |

directCli mode mirrors multica's "shell out by name": the bridge finds `claude`
on PATH and spawns it with the standard `-p --output-format stream-json --verbose …`
flags. It is how you reuse the official **native-exe** Claude Code, which ships
no `runtime.bundle.br` and therefore cannot be linked.

```typescript
// directCli mode — reuse the locally installed claude directly
const sdk = await createActoviqBridgeSdk({ directCli: true, workDir });
// spawns: claude -p "<prompt>" --output-format stream-json --verbose ...
//   executable defaults to `claude` on PATH; cliPath is unused for a plain
//   binary, but a node+script pair still prepends cliPath.

// bundle mode (default) — the vendored runtime
const sdk2 = await createActoviqBridgeSdk({ workDir });
// spawns: bun vendor/actoviq-runtime/cli.js -p "<prompt>" --output-format ...
```

**Provider isolation (both modes):** before spawning, `buildChildEnvironment`
maps `~/.actoviq/settings.json` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
/ `ANTHROPIC_MODEL` and injects them into the child, overriding the child's own
`~/.claude/settings.json`. So the interactive `claude` can stay on Claude
official while the bridge's child runs on DeepSeek (or any Anthropic-compatible
endpoint) — see `src/config/anthropicEnvMapping.ts`.

### directCli providers (claude / pi / codex)

directCli is not claude-only. `directCliProvider` picks which local CLI to spawn;
each provider is a `RuntimeProvider` (`src/parity/bridgeProviders.ts`) supplying
argv construction, env injection, and a per-run event normalizer that translates
the provider's native JSONL into the `system/assistant/result` trio `execute()`
already switches on.

| Provider | binary | entry | native protocol → normalized |
|---|---|---|---|
| `claude` (default) | `claude` | `claude -p --output-format stream-json …` | stream-json (passthrough) |
| `pi` | `pi` | `pi -p --mode json …` | `session`/`message_update`/`message_end`/`agent_end` |
| `codex` | `codex` | `codex exec --json …` | `thread.started`/`item.completed`(agent_message)/`turn.completed`/`turn.failed` |

```typescript
const piSdk = await createActoviqBridgeSdk({ directCli: true, directCliProvider: 'pi', workDir });
const codexSdk = await createActoviqBridgeSdk({ directCli: true, directCliProvider: 'codex', workDir });
```

- **Credentials differ:** claude → `ANTHROPIC_*`; pi/codex → their own
  (`OPENAI_API_KEY`, etc.) via the settings env block, no `ANTHROPIC_*` remap.
- **Introspection degrades for pi/codex:** their startup events carry no
  tools/skills/agents catalog, so `getRuntimeInfo`/`listSkills`/`getRuntimeCatalog`
  return limited data. Lifecycle methods (run/stream/session/fork) are fully aligned.

### Compatibility Matrix

```typescript
function getActoviqCleanBridgeParityMatrix(): ParityMatrix {
  // Maps Hadamard SDK features to bridge equivalents
  // Tracks: supported, partial, unsupported, not-applicable
}
```

### Bridge Limitations

| Feature | Bridge Support |
|---|---|
| Tool execution | Full (via child process) |
| Subagent delegation | Partial (bridge's own agent system) |
| Session persistence | Bridge's own format |
| Streaming | Bridge output parsing |
| Custom tools | Limited (MCP only) |
| Memory/Dream | Not available |
| Worktree isolation | Bridge's own worktree support |

### Why Two Bridge Wrappers Exist

1. **`actoviqBridgeSdk`**: Direct, low-level bridge access. Used when you want
   the bridge runtime exactly as-is.
2. **`actoviqCleanBridgeCompatSdk`**: Hadamard-shaped API over the bridge.
   Enables swapping Hadamard SDK ↔ bridge runtime without changing calling
   code. Used for A/B testing and parity verification.
