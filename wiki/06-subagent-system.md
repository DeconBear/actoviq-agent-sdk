# 06 — Subagent System

## Architecture

Subagents are independently executed agent sessions spawned by the parent agent
via the `Agent`/`Task` tool. They can run in the foreground (blocking) or
background (non-blocking with notification injection).

Location: `src/runtime/actoviqAgents.ts`, `src/runtime/agentClient.ts:2500-3000`,
`src/runtime/actoviqBackgroundTasks.ts`

### Design Principles

- **Session-per-subagent**: each subagent gets its own `StoredSession` with
  independent message history
- **Inherited context**: subagents inherit permission mode, effort, hooks, and
  tool policies from the parent
- **Notification-driven**: background subagents inject `<task_notification>` XML
  into the parent's next model request — no polling needed
- **Worktree isolation**: subagents can run in isolated git worktrees to prevent
  file conflicts

## Module Design

### Files

| File | Role |
|---|---|
| `actoviqAgents.ts` | Agent/Task tool definitions, delegation option extraction |
| `actoviqAgentDefinitions.ts` | Markdown agent definition loader |
| `defaultActoviqAgents.ts` | Built-in agent definitions (Explore, Plan, general-purpose) |
| `actoviqBackgroundTasks.ts` | Background task lifecycle: launch, track, cancel, reconcile |

### Delegation Architecture

```
Parent Session
    │
    ├── Agent/Task tool invoked { description, prompt, subagent_type, ... }
    │       │
    │       ├── Foreground (run_in_background: false)
    │       │   ├── Create child StoredSession
    │       │   ├── Build agent-specific system prompt
    │       │   ├── Run executeConversation() in-process
    │       │   ├── Return result to parent tool call
    │       │   └── Finalize workspace (dispose clean worktree)
    │       │
    │       └── Background (run_in_background: true)
    │           ├── Create child StoredSession
    │           ├── Store in BackgroundTaskStore
    │           ├── Launch non-blocking Promise
    │           ├── Emit progress updates
    │           ├── On completion → store result, queue notification
    │           └── On failure → store error, queue notification
    │
    ├── SendMessage tool
    │   ├── Running agent → queue in subagentInputQueues
    │   │   (delivered at next tool boundary)
    │   └── Completed agent → resume session, re-run with message
    │
    └── Shared state (ActoviqAgentClient Maps)
        ├── pendingDelegations: Map<parentRunId, delegation[]>
        ├── pendingRuntimeNotifications: Map<sessionId, notification[]>
        ├── subagentInputQueues: Map<agentId, queuedMessages[]>
        └── sessionRuntimeOverrides: Map<sessionId, overrides>
```

### Foreground Delegation Flow

```
1. Agent tool invoked
    → requireAgentDefinition(subagent_type)
        • Look up in agentDefinitions Map
        • Apply tool allow/deny filtering
        • Apply skill, effort, permission overrides
    → prepareDelegatedWorkspace(definition, delegation)
        • isolation: 'worktree' → createGitWorktreeWorkspace()
        • cwd override → use explicit directory
        • default → inherit parent workDir
    → extractInheritedDelegationOptions()
        • Inherit: permission, hooks, effort, metadata
        • Enforce: maxDepth, maxFanout, allowedAgents
    → Create child StoredSession
    → Build agent system prompt (definition body + filtered tools)
    → executeConversation(childSession, prompt, ...)
    → finalizeDelegatedWorkspace()
        • Clean worktree (no changes) → dispose
        • Dirty worktree (has changes) → retain, return path
    → Return { result, sessionId, worktreePath, worktreeBranch }
```

### Background Delegation Flow

```
1. Agent tool invoked (run_in_background: true)
    → Same preparation as foreground up to session creation
    → Store in BackgroundTaskStore (status: 'running')
    → launchBackgroundOnSession()
        • Wrap in try/catch
        • Update progress via updateProgress callback
        • On completion → store result, set status 'completed'
        • On failure → store error, set status 'failed'
    → Queue notification for parent session
        pendingRuntimeNotifications.push({ taskId, text: resultSummary })
    → Return immediately (non-blocking)

2. Next parent model request
    → prepareRunAugmentations()
        → collectPendingTaskNotifications()
            • Consume pendingRuntimeNotifications queue
            • Scan BackgroundTaskStore for completed tasks
            • Format as <task_notification> XML blocks
            • Inject as prefixedMessages before user input
```

### Background Task Lifecycle

```
                            ┌─────────┐
                            │ running  │
                            └────┬─────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │completed │ │ failed   │ │cancelled │
              └──────────┘ └──────────┘ └──────────┘
```

**Cancel flow** (`cancel()` in `actoviqBackgroundTasks.ts`):
1. Check if task is in terminal state → return existing (don't overwrite)
2. Call `AbortController.abort()`
3. **Re-read from store** (TOCTOU protection — task may have completed between
   step 1 and step 2)
4. If now terminal → return refreshed state
5. Otherwise → set status 'cancelled', save

### Nested Delegation Controls

| Control | Source | Default |
|---|---|---|
| `maxSubagentDepth` | `ActoviqAgentClient` constructor | 1 (one level) |
| `maxSubagentFanout` | `ActoviqAgentClient` constructor | 8 |
| Per-definition `allowedAgents` | Agent definition frontmatter | undefined (all) |
| Per-definition `disallowedTools` | Agent definition frontmatter | undefined |
| Per-definition `maxDepth` | Agent definition frontmatter | inherit from parent |

### Agent Definitions

Three sources (merged at init time):

1. **Programmatic**: `createAgentSdk({ agents: [...] })`
2. **Markdown files**: `~/.actoviq/agents/*.md` (user) + `.actoviq/agents/*.md` (project)
3. **Built-in**: `getDefaultActoviqAgents()` → Explore, Plan, general-purpose

Markdown format (frontmatter + body):
```markdown
---
name: auditor
description: Audit code without nested delegation
tools: Read, Grep, Glob
disallowedTools: Write, Edit
skills: release-checklist
effort: high
permissionMode: plan
memory: project
---
You are a project audit specialist.
```

Resolution order: programmatic → project `.md` → user `~/.md` → built-in.
First match wins (programmatic takes highest priority).

## Code Details

### `createActoviqTaskTool()`

Location: `src/runtime/actoviqAgents.ts:166`

Creates the `Agent`/`Task` tool with all delegation callbacks:

```typescript
export function createActoviqTaskTool(options: {
  listAgentDefinitions, getAgentDefinition, runAgent, launchBackgroundAgent,
  onDelegated, name, description, maxDepth, maxFanout,
}): AgentToolDefinition {
  return tool({
    name: options.name ?? 'Agent',
    aliases: options.name === 'Task' ? undefined : ['Task'],
    description: 'Launch a new agent to handle complex, multi-step tasks...',
    inputSchema: z.strictObject({
      description: z.string(),
      prompt: z.string(),
      subagent_type: z.string().optional(),
      run_in_background: z.boolean().optional(),
      name: z.string().optional(),
      isolation: z.enum(['worktree']).optional(),
      cwd: z.string().optional(),
    }),
  }, async (input, context) => {
    if (input.run_in_background) {
      const task = await options.launchBackgroundAgent(/* ... */);
      return { status: 'launched', taskId: task.id };
    }
    const { result } = await options.runAgent(/* ... */);
    return { status: 'completed', text: result.text, /* ... */ };
  });
}
```

### `prepareDelegatedWorkspace()`

```typescript
private async prepareDelegatedWorkspace(
  definition: ActoviqAgentDefinition,
  delegation: { name?, isolation?, cwd? },
): Promise<{ workDir: string; workspace?: ActoviqWorkspace }> {
  if (delegation.cwd) return { workDir: path.resolve(delegation.cwd) };
  
  const isolation = delegation.isolation ?? definition.isolation;
  if (isolation !== 'worktree') {
    return { workDir: path.resolve(definition.cwd ?? this.config.workDir) };
  }
  
  const workspace = await createGitWorktreeWorkspace({
    repositoryPath: this.config.workDir,
    branch: `actoviq-agent-${createId().slice(0, 8)}`,
  });
  
  return { workDir: workspace.path, workspace };
}
```

### Background Task TOCTOU Fix

```typescript
async cancel(taskId: string): Promise<BackgroundTaskRecord> {
  const existing = await this.store.load(taskId);
  if (existing.status === 'completed' || existing.status === 'failed' 
      || existing.status === 'cancelled') {
    return existing; // Already terminal, don't overwrite
  }
  
  this.abortControllers.get(taskId)?.abort();
  
  // Re-read to avoid TOCTOU — task may have completed between
  // the initial check and abort
  const refreshed = await this.store.load(taskId);
  if (refreshed.status === 'completed' || refreshed.status === 'failed'
      || refreshed.status === 'cancelled') {
    return refreshed;
  }
  
  // Truly still running — mark cancelled
  const cancelled = { ...refreshed, status: 'cancelled', ... };
  await this.store.save(cancelled);
  return cancelled;
}
```

### `SendMessage` — `routeMessageToAgent()`

Resolves target by:
1. Agent name → look up in `backgroundTaskManager` running list
2. Task ID → direct lookup
3. Session ID → direct lookup

If running → queue in `subagentInputQueues` (delivered at next tool boundary).
If completed → reload session from store, re-launch with the message as input,
link to original task via `resumedFromTaskId`.
