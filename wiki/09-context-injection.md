# 09 — Context Injection

## Architecture

Before each model request, the SDK augments the conversation with additional
context: background task notifications, memory, dream results, tool prompts,
skill prompts, and environment information. This is the "context injection
pipeline."

Location: `src/runtime/agentClient.ts:2105` (`prepareRunAugmentations`),
`src/runtime/actoviqCompact.ts`

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

Location: `src/runtime/actoviqCompact.ts`

Two compaction modes:

**Microcompact** (per-request): Trims oversized tool results before each API
call to keep request size under provider limits.

**Full compact** (mid-conversation): When context exceeds
`autoCompactThresholdTokens` (default 155K), summarizes old messages via the
model, preserves recent messages (default 8), and injects the summary as a
synthetic system message.

```
Context size check (before each model request)
    │
    ├── < 155K tokens → no action
    │
    └── ≥ 155K tokens → compactActoviqConversationIfNeeded()
        │
        ├── Microcompact first (trim old tool results)
        │   • Clear tool results older than microcompactKeepRecentToolResults
        │   • Artifact oversized results to files
        │   • Replace with placeholder text
        │
        ├── If still too large → full compact
        │   • Select messages to summarize
        │   • Call model to generate summary
        │   • Preserve recent messages (default 8)
        │   • Inject summary as system message
        │   • Maintain tool_use_id ↔ tool_result pairing
        │
        └── Circuit breaker: 3 consecutive failures → stop compacting
```

### Compaction State Persistence

Compaction metadata is stored in `StoredSession.metadata`:
```typescript
metadata: {
  __actoviqCompactState: {
    compactCount: number;
    microcompactCount: number;
    consecutiveFailures: number;
    lastCompactedAt: string;
    lastTrigger: ActoviqCompactTrigger;
  },
  __actoviqCompactHistory: [/* per-compaction entries */],
  __actoviqRecentFiles: ['/path/to/file.ts', ...],   // max 5
  __actoviqRecentSkills: ['skill-name', ...],         // max 5
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
    todoSnapshot: getActoviqTodoSnapshot(),
  });

  // 4. Model resolution
  const model = resolveActoviqModelReference(
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

### `compactActoviqConversationIfNeeded()`

```typescript
export async function compactActoviqConversationIfNeeded(
  messages: MessageParam[],
  context: ActoviqCompactExecutionContext,
): Promise<{ messages: MessageParam[]; compacted: boolean; error?: string }> {
  // 1. Estimate current token count
  const estimatedTokens = estimateActoviqConversationTokens(messages);

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
    // 4. Microcompact: trim old tool results
    const microcompacted = microcompactConversation(messages, context);

    // 5. Full compact: summarize old messages
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
written to a file under `~/.actoviq/projects/<hash>/artifacts/` and replaced
with a placeholder in the conversation. The model can reference the artifact
path if needed.
