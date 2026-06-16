# 03 — ReAct Loop

## Architecture

The ReAct loop is the core agent execution engine. It runs a `while(true)` loop:
send conversation to model → extract tool calls → execute tools → feed results
back → repeat until the model produces a text-only response.

Location: `src/runtime/conversationEngine.ts:90`

### Design Philosophy

- **Model-driven termination**: the loop stops when the model stops calling tools
- **Unlimited iterations by default**: `maxToolIterations = Infinity` (Hadamard
  Harness principle — the model decides when it's done)
- **Streaming-first**: events emitted in real-time for UI consumers
- **Error resilience**: 3 consecutive same-tool failures abort the loop

## Module Design

### Dependencies

```
conversationEngine.ts
    ├── types.ts              (AgentRunResult, AgentEvent, ModelRequest, etc.)
    ├── actoviqCompact.ts     (context size management)
    ├── actoviqPermissions.ts (tool permission decisions)
    ├── actoviqApiMicrocompact.ts (per-request message trimming)
    ├── messageUtils.ts       (content extraction, message building)
    ├── hooks/actoviqHooks.ts (post-sampling hooks)
    ├── mcp/connectionManager.ts (MCP tool resolution)
    └── tools/todo/TodoWriteTool.ts (todo snapshot for reminders)
```

### The Loop: Step by Step

```
executeConversation(options)
    │
    ├── [Init] Resolve model, effort, tools, conversation messages
    │
    ├── [Loop] while (true):
    │   │
    │   ├── 1. Resolve tool adapters for this iteration
    │   │      • MCP tools (connectionManager.resolveToolAdapters)
    │   │      • Session tools (options.tools)
    │   │      • Deduplicate by name
    │   │
    │   ├── 2. Build ModelRequest
    │   │      • System prompt (tools + skills + memory + env)
    │   │      • Messages (full conversation history)
    │   │      • Tool definitions (JSON Schema)
    │   │      • Model, maxTokens, temperature, effort
    │   │      • Skip context_management for non-Anthropic providers
    │   │      • Strip type:custom for DeepSeek
    │   │
    │   ├── 3. Send to model
    │   │      • Streaming: iterate AsyncGenerator<MessageStreamEvent>
    │   │      • Non-streaming: await modelApi.createMessage()
    │   │
    │   ├── 4. Extract tool_use blocks
    │   │      • From assistant message content
    │   │      • If none → return AgentRunResult (LOOP ENDS)
    │   │
    │   ├── 5. Execute tools (up to MAX_CONCURRENT_TOOL_USES = 10)
    │   │      • For each tool_use:
    │   │        a. Validate input (Zod parse)
    │   │        b. Permission check (decideActoviqToolPermission)
    │   │        c. Execute (adapter.execute)
    │   │        d. Handle error → ToolExecutionError
    │   │        e. Track consecutive same-tool failures
    │   │
    │   ├── 6. Push tool_result blocks
    │   │      • Format as { role: "user", content: [tool_result] }
    │   │      • tool_use_id must match across messages
    │   │      • Truncate oversized results
    │   │
    │   ├── 7. Check stop conditions
    │   │      • maxToolIterations reached? → stop (if configured)
    │   │      • 3 consecutive same-tool failures? → abort
    │   │      • signal.aborted? → throw RunAbortedError
    │   │
    │   ├── 8. Compact if needed
    │   │      • Microcompact: trim old tool results per-request
    │   │      • Full compact: summarize old messages mid-conversation
    │   │
    │   └── 9. Emit events + continue loop
    │
    └── [Return] AgentRunResult { text, toolCalls, requests, messages, usage }
```

### Abort & Error Handling

| Condition | Behavior |
|---|---|
| `signal.aborted` | Throw `RunAbortedError` before next model request or after tool execution |
| 3 consecutive same-tool failures | Abort loop (prevents infinite retry) |
| `max_tokens` exhaustion | Retry up to 3 times with extended `maxTokens` (exponential backoff) |
| `maxToolIterations` reached | Stop loop (only if explicitly configured — default Infinity) |

### Streaming vs Non-Streaming

```
streaming: true
    → modelApi.streamMessage()
    → AsyncGenerator<MessageStreamEvent>
    → Events emitted in real-time:
        response.text.delta   (per-token text)
        response.content      (thinking blocks)
        tool.call             (tool invocation detected)
        tool.progress         (execution progress)
        tool.result           (execution complete)
        error                 (request/execution failure)
        session.compacted     (context trimmed)

streaming: false
    → modelApi.createMessage()
    → Full Message returned
    → Tool extraction + execution (same as streaming)
    → No intermediate events
```

### Todo Reminders

Every `TODO_REMINDER_INTERVAL` (10) iterations, the system injects a todo list
snapshot into the system prompt to help the model track progress.

## Code Details

### Main Function Signature

```typescript
export async function executeConversation(
  options: ExecuteConversationOptions,
): Promise<AgentRunResult> {
  // options includes:
  //   runId, input, messages, prefixedMessages, sessionId
  //   systemPrompt, tools, mcpServers, model, maxTokens
  //   temperature, toolChoice, userId, metadata, effort
  //   signal, permissionMode, permissions, classifier, approver
  //   canUseTool, hooks, drainQueuedInputs
  //   streaming, emit, skipRunStartedEvent
  //   modelApi, config, mcpManager
}
```

### Constants

```typescript
const MAX_CONCURRENT_TOOL_USES = 10;      // Max parallel tool executions
const TODO_REMINDER_INTERVAL = 10;        // Iterations between todo snapshots
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;  // Max retries for token exhaustion
```

### Tool Execution Detail

```typescript
// For each tool_use block from the model:
for (const toolUse of toolUses) {
  // 1. Find matching adapter
  const adapter = resolvedAdapters.find(a => a.name === toolUse.name);

  // 2. Parse input against Zod schema
  const parsedInput = adapter.inputSchema.parse(toolUse.input);

  // 3. Permission check
  const decision = await decideActoviqToolPermission({
    mode, rules, classifier, approver, canUseTool,
    adapter, runId, sessionId, workDir,
    toolName, publicName, toolInput, iteration,
  });

  // 4. Execute (if allowed)
  const result = await adapter.execute(parsedInput, context);

  // 5. Track errors
  if (result.isError) {
    consecutiveFailures = (prevSameTool === toolUse.name) ? prev + 1 : 1;
    if (consecutiveFailures >= 3) abort();
  }
}
```

### Post-Sampling Hooks

After each model response, `resolveActoviqPostSamplingHooks()` runs registered
hooks. Hooks receive the full messages array and can inject additional context.

### Message Pairing Invariant

`tool_use_id` in the assistant's `tool_use` block MUST match `tool_use_id` in
the subsequent `tool_result` block. These live in **separate messages**:
- Assistant message: `{ role: "assistant", content: [{ type: "tool_use", id: "X", ... }] }`
- User message: `{ role: "user", content: [{ type: "tool_result", tool_use_id: "X", ... }] }`

The compaction system (`extendPreserveToIncludeReferencedToolUses()`) prevents
this pairing from being broken when old messages are summarized.
