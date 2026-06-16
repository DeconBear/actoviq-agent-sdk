# 20 — Coupling & Sharp Edges

Cross-cutting concerns, known design issues, and areas requiring attention
during refactoring.

## Coupling Analysis

### Tight Coupling (Risks)

| Location | Issue | Risk Level | Mitigation |
|---|---|---|---|
| `agentClient.ts:591-597` | 4 shared Maps without locks | **High** | Node.js event loop prevents true parallel races; async interleaving still vulnerable (TOCTOU) |
| `agentClient.ts` (3820 lines) | God class with 12 API surfaces | **High** | Planned: extract SubagentOrchestrator, ContextAugmentor |
| `conversationEngine.ts` → `agentClient.ts` | ReAct loop depends on compaction, permissions, hooks from client | **Medium** | Deps passed via options object, not direct imports |
| `actoviqAgents.ts` → `agentClient.ts` | Task tool callbacks close over client methods | **Medium** | Tool cannot be tested without full client |
| `actoviqCompact.ts` ↔ `conversationEngine.ts` | Compaction references tool_use_id pairing logic in engine | **Medium** | Pairing invariant documented; `extendPreserveToIncludeReferencedToolUses()` guard |

### Loose Coupling (Good Patterns)

| Location | Pattern | Benefit |
|---|---|---|
| `tool()` factory | Plain objects with `execute` functions | Tools testable independently |
| `resolveRuntimeConfig()` | Pure config function | Deterministic, testable with mock options |
| `SessionStore` | Storage behind interface | Swappable to DB without caller changes |
| `ModelApi` interface | Provider-agnostic | New providers without touching ReAct loop |
| `AgentSessionBindings` | Callback injection | Session testable with mock bindings |

## Known Sharp Edges

### 1. Shared Mutable State Without Locking

`agentClient.ts:591-597`: Four Maps (`pendingDelegations`, `pendingRuntimeNotifications`,
`subagentInputQueues`, `sessionRuntimeOverrides`) are shared across concurrent
subagent operations without synchronization.

**Impact**: Async interleaving at `await` boundaries can cause TOCTOU bugs.
**History**: `cancel()` in `actoviqBackgroundTasks.ts` had a TOCTOU race (task
completes between status check and abort call). Fixed by re-reading store after
abort.

**Recommendation**: Replace Maps with per-session lock manager or
`AsyncLocalStorage`-backed context.

### 2. God Class Anti-Pattern

`ActoviqAgentClient` (~3820 lines) directly owns: session lifecycle, tool
management, subagent delegation, background tasks, context augmentation,
notification injection, SendMessage routing, workspace management, MCP
lifecycle, and hook invocation.

**Recommendation**:
1. Extract `SubagentOrchestrator` (delegation, background tasks, SendMessage)
2. Extract `ContextAugmentor` (notifications, memory, dream, system prompt)
3. Keep `ActoviqAgentClient` as facade delegating to these classes

### 3. `tool_use_id` Pairing Invariant

`tool_use_id` must match between the assistant's `tool_use` block and the
subsequent user message's `tool_result` block. These live in **separate
messages**. Compaction can accidentally separate these pairs.

**Guard**: `extendPreserveToIncludeReferencedToolUses()` in `actoviqCompact.ts`
ensures the preservation window always includes both sides of the pair. Any
change to compaction logic must preserve this invariant.

### 4. Provider-Specific Tool Stripping

DeepSeek's Anthropic-compatible endpoint rejects `type: "custom"` on tools.
The fix strips the `type` field before sending. This is fragile — if new
tool metadata fields are added, they may also need stripping.

### 5. `isGitWorkspaceDirty` Defaults to Clean

The method returns `false` on timeout or error (git unavailable). This is
intentional — treating unknown state as "not dirty" prevents worktree leaks.
But it means transient git failures silently discard worktree changes.

### 6. Windows Path Handling

`robustJsonParse()` in `src/provider/json-parse.ts` handles malformed JSON with
unescaped Windows paths. Some providers return tool arguments with literal
backslashes. The parser applies progressively more aggressive fixes.

### 7. `close()` Error Aggregation

Cleanup runs independently with try/catch per step. Errors collected into
`AggregateError`. One failing step (MCP disconnect) doesn't block others
(background task cancellation).

### 8. Flaky Test

`tests/actoviq-dream.spec.ts` has a pre-existing flaky test (ENOENT on
`project-memory.md`). The file may not exist when the test runs depending on
test order and cleanup timing.

### 9. Pipeline Error Silently Drops Items

In Dynamic Workflows (planned), pipeline stage errors drop the item to `null`
and skip remaining stages. While this is intentional (one failed item shouldn't
cascade-abort the pipeline), errors need to be collected and surfaced in the
workflow result to avoid silent data loss.

### 10. No Request Retry for Transient Failures

The ReAct loop doesn't retry on transient provider errors (network blips,
rate limits). It relies on the model to handle errors reported via tool_result.
For long-running operations, this can mean losing progress on a single network
glitch.

## Architecture Decision Records

### ADR-1: In-Process ReAct Loop

**Decision**: Run the ReAct loop in the same Node.js process rather than a
child process.
**Rationale**: Full debuggability, no IPC overhead, direct filesystem access.
**Trade-off**: A crash in the loop crashes the host.

### ADR-2: JSON File Storage

**Decision**: Use JSON files on disk rather than SQLite or other databases.
**Rationale**: Human-readable, portable, no native dependencies, crash-safe
(atomic writes via temp file + rename).
**Trade-off**: No concurrent access, no query capabilities.

### ADR-3: Zod v4 for Tool Schemas

**Decision**: Use Zod v4 `strictObject()` for all tool input schemas.
**Rationale**: Type-safe runtime validation, auto-generated JSON Schema,
`additionalProperties: false` enforcement.
**Trade-off**: Zod v4 is relatively new; ecosystem tooling still maturing.

### ADR-4: Unlimited Iterations by Default

**Decision**: `maxToolIterations` defaults to `Infinity`.
**Rationale**: Hadamard Harness principle — the model decides when to stop.
Matches Claude Code's main agent behavior.
**Trade-off**: Runaway loops possible if the model gets stuck (mitigated by
3-consecutive-failure abort).

### ADR-5: Background Tasks via Notification Injection

**Decision**: Background subagent results are injected as XML
`<task_notification>` blocks rather than requiring the model to poll.
**Rationale**: The model receives results passively — no polling tool needed.
Matches Claude Code's notification pattern.
**Trade-off**: Tight coupling between notification format and model's ability
to parse it correctly.
