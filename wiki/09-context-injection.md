# 09 — Context Injection

## Architecture

Before each model request, the SDK augments the conversation with additional
context: background task notifications, memory, dream results, tool prompts,
skill prompts, and environment information. This is the "context injection
pipeline."

Location: `src/runtime/agentClient.ts:2105` (`prepareRunAugmentations`),
`src/runtime/hadamardCompact.ts`

### Design Principles

- **Pre-request injection**: all augmentation happens before the model sees the
  conversation — the model never needs to "check" for notifications
- **Consumable notifications**: pending notifications are consumed once and
  removed from the queue (avoids repeated injection)
- **Memory freshness**: memories include age metadata so the model can
  contextualize their relevance

## Module Design

### System Prompt Construction

```
System Prompt = 
    User-provided system prompt (or default)
    + Tool prompts (collected from all registered tools)
    + Skill prompts (from matching skills)
    + Memory context (relevant memories with freshness)
    + Dream results (consolidation output)
    + Buddy personality (if configured)
    + Environment block (workDir, git status, platform, date)
    + Todo snapshot (every 10 iterations)
```

### Notification Injection

```
Before each parent model request:
    │
    ▼
collectPendingTaskNotifications(sessionId)
    ├── Consume pendingRuntimeNotifications queue
    ├── Scan BackgroundTaskStore for completed tasks
    │   (filter by parentSessionId + status === 'completed')
    ├── Format as <task_notification> XML blocks
    │   <task_notification>
    │     <task_id>...</task_id>
    │     <agent_name>...</agent_name>
    │     <status>completed</status>
    │     <result>...</result>
    │     <usage>...</usage>
    │     <worktree>...</worktree>
    │   </task_notification>
    └── Inject as prefixedMessages (before user input)
```

### Compaction System

Location: `src/runtime/hadamardCompact.ts`, `src/runtime/conversationEngine.ts`

**Prefix-stable policy (Hadamard + Claude Code alignment):** do **not** rewrite
historical `tool_result` content between turns. Sliding-window “clear old tool
results” breaks automatic prefix caches (DeepSeek Context Caching, etc.).
Oversized outputs are artifacted **when written**; later pressure uses a full
summary compact instead.

**Full compact** (mid-conversation / session): When context exceeds
`autoCompactThresholdTokens` (default 155K), summarizes old messages via the
model, preserves recent messages (default 8), and injects the summary as a
synthetic user/system reminder. One intentional cache miss, then the new prefix
is stable again.

**Anthropic prompt cache:** on `*.anthropic.com` hosts, requests may add
`cache_control` breakpoints on system / tools / last message. Third-party
Anthropic-compatible hosts (DeepSeek, MiniMax, …) rely on provider-side
automatic caching; DeepSeek usage fields `prompt_cache_hit_tokens` are mapped
to `cache_read_input_tokens` for local reporting.

```
Context size check (before each model request)
    │
    ├── < threshold → append-only history (no rewrite)
    │
    └── ≥ threshold → compactHadamardConversationIfNeeded()
        │
        ├── Full summary compact only
        │   • Optionally preprocess cleared tool text as summary *input*
        │   • Never persist microcompact-only mutations to the live session
        │   • Preserve recent messages (default 8)
        │   • Maintain tool_use_id ↔ tool_result pairing
        │
        └── Circuit breaker: 3 consecutive failures → stop compacting
```

Session-level `compactHadamardSession` (used by `createAgentSdk` / `hadamard-tui`
after turns) follows the same rule: below threshold → unchanged session; above
threshold → full summary only.

### Compaction State Persistence

Compaction metadata is stored in `StoredSession.metadata`:
```typescript
metadata: {
  __hadamardCompactState: {
    compactCount: number;
    microcompactCount: number;
    consecutiveFailures: number;
    lastCompactedAt: string;
    lastTrigger: HadamardCompactTrigger;
  },
  __hadamardCompactHistory: [/* per-compaction entries */],
  __hadamardRecentFiles: ['/path/to/file.ts', ...],   // max 5
  __hadamardRecentSkills: ['skill-name', ...],         // max 5
}
```

## Code Details

### `prepareRunAugmentations()` Full Flow

```typescript
private async prepareRunAugmentations(
  runId: string,
  input: string | MessageParam['content'],
  options: AgentRunOptions,
  session?: StoredSession,
): Promise<PreparedRunAugmentations> {
  const prefixedMessages: MessageParam[] = [];

  // 1. Pending background task notifications
  if (session) {
    const notifications = await this.collectPendingTaskNotifications(session.id);
    prefixedMessages.push(...notifications);
  }

  // 2. Dream consolidation results
  if (session) {
    const dreamResults = await this.maybeInjectDreamResults(session);
    if (dreamResults) prefixedMessages.push(...dreamResults);
  }

  // 3. System prompt construction
  const systemPrompt = await buildSystemPrompt({
    userPrompt: options.systemPrompt,
    tools: resolvedTools,
    skills: this.skillDefinitions,
    memory: memoryContext,
    buddy: this.buddy.getActiveBuddy(),
    workDir: this.config.workDir,
    todoSnapshot: getHadamardTodoSnapshot(),
  });

  // 4. Model resolution
  const model = resolveHadamardModelReference(
    options.model ?? session?.model ?? this.config.model,
    this.config.modelTiers,
  );

  return { systemPrompt, prefixedMessages, model, /* ... */ };
}
```

### `collectPendingTaskNotifications()` XML Format

```typescript
function formatTaskNotification(task: BackgroundTaskRecord): string {
  const lines = [
    '<task_notification>',
    `<task_id>${escapeXml(task.id)}</task_id>`,
    `<agent_name>${escapeXml(task.agentName ?? '')}</agent_name>`,
    `<status>${escapeXml(task.status)}</status>`,
    task.text ? `<result>${escapeXml(task.text)}</result>` : undefined,
    task.error ? `<error>${escapeXml(task.error)}</error>` : undefined,
    `<usage><requests>${task.requestCount ?? 0}</requests>` +
    `<tool_uses>${task.toolCallCount ?? 0}</tool_uses>` +
    `<tool_errors>${task.toolErrorCount ?? 0}</tool_errors></usage>`,
    task.retainedWorktree && task.worktreePath
      ? `<worktree><path>${escapeXml(task.worktreePath)}</path>` +
        (task.worktreeBranch ? `<branch>${escapeXml(task.worktreeBranch)}</branch>` : '') +
        `</worktree>`
      : undefined,
    '</task_notification>',
  ];
  return lines.filter(Boolean).join('\n');
}
```

### `compactHadamardConversationIfNeeded()`

```typescript
export async function compactHadamardConversationIfNeeded(
  messages: MessageParam[],
  context: HadamardCompactExecutionContext,
): Promise<{ messages: MessageParam[]; compacted: boolean; error?: string }> {
  // 1. Estimate current token count
  const estimatedTokens = estimateHadamardConversationTokens(messages);

  // 2. Check threshold
  if (estimatedTokens < context.compactConfig.autoCompactThresholdTokens) {
    return { messages, compacted: false };
  }

  // 3. Circuit breaker check
  const failures = compactionFailureCounts.get(context.workDir) ?? 0;
  if (failures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    return { messages, compacted: false, error: 'Circuit breaker open' };
  }

  try {
    // 4. Optional microcompact only as *input preprocess* for the summary call.
    //    Never return microcompact-only mutations to the live conversation.
    const microcompacted = microcompactConversation(messages, context);

    // 5. Full compact: summarize old messages; on failure return original messages
    const compacted = await fullCompactConversation(microcompacted, context);

    compactionFailureCounts.delete(context.workDir);
    return { messages: compacted, compacted: true };
  } catch (error) {
    const failures = (compactionFailureCounts.get(context.workDir) ?? 0) + 1;
    compactionFailureCounts.set(context.workDir, failures);
    return { messages, compacted: false, error: asError(error).message };
  }
}
```

### Tool Result Artifacting

When a tool result exceeds `toolResultArtifactMaxChars` (default 80K), it's
written to a file under `~/.hadamard/projects/<hash>/artifacts/` and replaced
with a placeholder in the conversation. The model can reference the artifact
path if needed.
