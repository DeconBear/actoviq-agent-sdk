# 04 — Agent Client

## Architecture

`ActoviqAgentClient` is the central orchestrator. Every SDK operation flows
through it. It's the "god class" — ~3820 lines, 12 public API surfaces,
4 shared mutable state Maps.

Location: `src/runtime/agentClient.ts:575`

### Design Rationale

The client is large by necessity: subagent delegation, background tasks, context
augmentation, and tool lifecycle are deeply intertwined. Extracting them would
require passing the same shared state through many layers.

**Current approach**: Monolith with clear method boundaries.
**Future direction**: Extract `SubagentOrchestrator`, `ContextAugmentor` as
separate classes behind the same facade.

## Module Design

### Constructor Dependencies

```
ActoviqAgentClient.create(config, store, backgroundTaskStore,
    mailboxStore, teammateStore, modelApi, mcpManager,
    defaultTools, defaultMcpServers, hooks,
    agentDefinitions, skillDefinitions,
    defaultPermissionMode, defaultPermissions,
    defaultClassifier, defaultApprover,
    sessionManagerConfig, maxSubagentDepth, maxSubagentFanout)
```

All dependencies are injected — the client doesn't read config files, env vars,
or create its own storage. This makes testing possible (inject mocks).

### Key Method Groups

**Session lifecycle** (~lines 900-1300):
```
createSession(options) → AgentSession
resumeSession(id, options) → AgentSession
  ├── SessionStore.load()
  ├── Restore permission context
  ├── Reconcile background tasks
  └── SessionManager.register()
```

**Run execution** (~lines 1800-2200):
```
run(prompt, options?) → AgentRunResult
stream(prompt, options?) → AgentRunStream
  ├── prepareRunAugmentations()
  │   ├── collectPendingTaskNotifications()
  │   ├── Inject dream/memory contexts
  │   └── Build system prompt
  ├── Resolve model (tier → concrete)
  ├── Resolve tools (session + MCP + options)
  └── executeConversation() or streamConversation()
```

**Subagent delegation** (~lines 2500-3000):
```
runWithAgent(agent, prompt, options?, delegation?) → { result, sessionId, worktreePath }
launchBackgroundAgentTask(agent, prompt, ...) → ActoviqBackgroundTaskRecord
  ├── requireAgentDefinition()
  ├── prepareDelegatedWorkspace()      (worktree or cwd)
  ├── extractInheritedDelegationOptions() (permission, effort, hooks)
  ├── Create child session
  ├── Execute foreground or launch background
  └── finalizeDelegatedWorkspace()     (dispose clean worktrees)
```

**Context augmentation** (~lines 2100-2800):
```
prepareRunAugmentations(runId, input, options, session?)
  ├── Collect pending task notifications (XML)
  ├── Inject dream consolidation results
  ├── Inject relevant memories
  ├── Build system prompt (tools + skills + env + buddy)
  └── Apply model tier resolution
```

## Code Details

### Shared Mutable State (Coupling Hotspot)

Four Maps shared across concurrent operations without locks:

```typescript
// agentClient.ts:591-597
private readonly pendingDelegations = new Map<string, PendingDelegationRecord[]>();
private readonly pendingRuntimeNotifications = new Map<string, Array<{ taskId: string; text: string }>>();
private readonly subagentInputQueues = new Map<string, string[]>();
private readonly sessionRuntimeOverrides = new Map<string, SessionRuntimeOverrides>();
```

**Risk**: Async interleaving can cause TOCTOU bugs. The background task
`cancel()` method already had one such race (fixed by re-reading store after
abort and checking terminal state).

**Mitigation**: Node.js single-threaded event loop prevents true parallel races,
but async boundaries (await) between Map read and Map write are vulnerable.

### `prepareRunAugmentations()` Flow

```typescript
private async prepareRunAugmentations(
  runId: string,
  input: string | MessageParam['content'],
  options: AgentRunOptions,
  session?: StoredSession,
): Promise<PreparedRunAugmentations> {
  // 1. Collect pending background task notifications
  const taskNotifications = await this.collectPendingTaskNotifications(session?.id);

  // 2. Collect dream consolidation results
  const dreamContext = await this.collectDreamContext(session);

  // 3. Collect relevant memories
  const memoryContext = await this.collectMemoryContext(session, input);

  // 4. Build system prompt
  const systemPrompt = await buildSystemPrompt({
    userPrompt: options.systemPrompt,
    tools: resolvedTools,
    skills: this.skillDefinitions,
    memory: memoryContext,
    dream: dreamContext,
    buddy: this.buddy.getActiveBuddy(),
    workDir: this.config.workDir,
  });

  return {
    systemPrompt,
    prefixedMessages: [...taskNotifications, ...dreamContext],
    // ...
  };
}
```

### `collectPendingTaskNotifications()` 

```typescript
private async collectPendingTaskNotifications(
  sessionId?: string,
): Promise<MessageParam[]> {
  if (!sessionId) return [];
  
  const notifications = this.pendingRuntimeNotifications.get(sessionId) ?? [];
  this.pendingRuntimeNotifications.delete(sessionId); // Consume once
  
  // Also scan backgroundTaskStore for completed tasks
  const completedTasks = await this.backgroundTaskStore.list();
  const sessionTasks = completedTasks.filter(
    t => t.parentSessionId === sessionId && t.status === 'completed'
  );
  
  // Format as <task_notification> XML blocks
  return [...notifications, ...sessionTasks].map(formatTaskNotification);
}
```

### `routeMessageToAgent()` — SendMessage Implementation

```typescript
private async routeMessageToAgent(
  target: string,
  message: string,
  context: { parentRunId: string; sessionId?: string },
): Promise<{ status: 'queued' | 'resumed'; taskId: string; agentId: string }> {
  // 1. Resolve target by agent name, task ID, or session ID
  const resolved = await this.resolveAgentTarget(target);
  
  // 2. Check if agent is currently running
  const runningTask = this.backgroundTaskManager.getRunningTask(resolved.agentId);
  
  if (runningTask) {
    // Queue message for delivery at next tool boundary
    const queue = this.subagentInputQueues.get(resolved.agentId) ?? [];
    queue.push(message);
    this.subagentInputQueues.set(resolved.agentId, queue);
    return { status: 'queued', taskId: runningTask.id, agentId: resolved.agentId };
  }
  
  // 3. Agent is stopped — resume session and re-run
  const session = await this.store.load(resolved.sessionId);
  const task = await this.launchBackgroundOnSession(session, message, resolved.taskId);
  return { status: 'resumed', taskId: task.id, agentId: resolved.agentId };
}
```

### Nested Delegation Controls

```typescript
private extractInheritedDelegationOptions(
  context: { permissionMode?, permissions?, hooks?, effort?, ... },
  delegation: { depth: number; allowedAgents?: string[]; model?: string },
): AgentRunOptions | undefined {
  // Enforce limits
  if (delegation.depth >= this.maxSubagentDepth) {
    throw new ActoviqSdkError('Maximum subagent depth exceeded');
  }
  
  // Fanout check
  const currentFanout = this.countActiveDelegations();
  if (currentFanout >= this.maxSubagentFanout) {
    throw new ActoviqSdkError('Maximum subagent fanout exceeded');
  }
  
  // Filter allowed agents
  if (delegation.allowedAgents?.length) {
    // Only agents in the allowed list can be spawned
  }
  
  return {
    permissionMode: context.permissionMode,
    permissions: context.permissions,
    hooks: context.hooks,
    effort: context.effort,
    // ...
  };
}
```
