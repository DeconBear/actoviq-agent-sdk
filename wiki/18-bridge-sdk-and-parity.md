# 18 — Bridge SDK & Parity

## Architecture

The Bridge SDK provides a compatibility layer that wraps a third-party agent
runtime (Claude Code) behind the same API surface as Hadamard SDK. This enables
direct behavioral comparison.

Location: `src/parity/*`

### Two Bridge Wrappers

| Wrapper | Entry | Purpose |
|---|---|---|
| `actoviqBridgeSdk` | `createActoviqBridgeSdk()` | Direct bridge: spawns `bun vendor/actoviq-runtime/cli.js` |
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
    ├── Verify runtime bundle exists (vendor/actoviq-runtime/cli.js)
    ├── Verify bun is installed
    │
    └── ActoviqBridgeSdkClient
        ├── createSession() → ActoviqBridgeSession
        ├── run(prompt) → spawn bun child process
        │   ├── Pass: --prompt, --work-dir, --model, --permission-mode
        │   ├── Pass: --max-turns (if budget configured)
        │   ├── Stream: stdout (SSE/text events)
        │   └── Parse: tool calls, results, final output
        └── close() → kill child process
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

### Child Process Execution

```typescript
// Bridge runner spawns:
const child = spawn('bun', [
  path.join(bundleDir, 'cli.js'),
  '--prompt', prompt,
  '--work-dir', workDir,
  '--model', model,
  '--permission-mode', permissionMode,
  '--max-turns', String(maxTurns),
  // ... more flags
]);

// Stream output parsing:
child.stdout.on('data', (chunk) => {
  // Parse SSE events or text output
  // Emit equivalent AgentEvent types
});
```

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
