# 01 — Entry & Overview

## Architecture

### Two-SDK Model

The repository provides two agent runtime surfaces sharing a common config,
tool, and storage layer:

```
                    ┌──────────────────────────┐
                    │   Shared Layer            │
                    │  • types.ts               │
                    │  • Config resolution      │
                    │  • Tool definitions       │
                    │  • Storage (sessions,     │
                    │    tasks, checkpoints)    │
                    │  • MCP, Hooks, Permissions│
                    └──────┬──────────┬────────┘
                           │          │
              ┌────────────▼──┐  ┌───▼──────────────────┐
              │ Hadamard SDK  │  │ actoviq-bridge-sdk    │
              │               │  │                       │
              │ createAgentSdk│  │ createActoviqBridgeSdk│
              │ In-process    │  │ Child process (bun)    │
              │ ReAct loop    │  │ Black-box runtime      │
              └───────────────┘  └───────────────────────┘
```

**Hadamard SDK** (`createAgentSdk()`): In-process execution. The ReAct loop
(`conversationEngine.ts`) runs directly in Node.js. All TypeScript source is
modifiable. Zero runtime dependencies beyond `zod` and `glob`.

**actoviq-bridge-sdk** (`createActoviqBridgeSdk()`): Spawns a `bun` child
process running a pre-compiled runtime bundle. Used as a reference
implementation and fallback. The ReAct loop inside the bundle is not modifiable.

### Harness Design Philosophy

> The SDK provides scaffolding, not constraints. The model makes the decisions.

| Layer | SDK provides | Model decides |
|---|---|---|
| ReAct loop | Tool dispatch, result collection | When to stop, what tool next |
| Subagents | Session spawning, notifications | What to delegate, how many |
| Workflows | `agent()`/`parallel()`/`pipeline()` | Script logic, convergence |
| Model Team | Multi-model dispatch, context | When to converge |
| Permissions | Rule evaluation, allow/deny | Whether to ask user |

### Config Priority Chain

```
CreateAgentSdkOptions  (programmatic)
    → process.env      (ACTOVIQ_*)
    → settings.json    (~/.actoviq/settings.json → env block)
    → Hard defaults    (provider=anthropic, maxTokens=32000, ...)
```

No auto-detection of provider or baseURL.

## Module Design

### Public API Surface

`src/index.ts` exports ~260 symbols organized into categories:

| Category | Key Exports |
|---|---|
| **Entry** | `createAgentSdk`, `createActoviqBridgeSdk` |
| **Config** | `resolveRuntimeConfig`, `loadJsonConfigFile`, `loadDefaultActoviqSettings` |
| **Runtime** | `ActoviqAgentClient`, `AgentSession`, `AgentRunStream` |
| **Tools** | `tool()`, `createActoviqCoreTools`, `createActoviqFileTools`, `createBashTool` |
| **Subagents** | `ActoviqAgentsApi`, `ActoviqBackgroundTaskManager`, `loadActoviqAgentDefinitions` |
| **Workflows** | `WorkflowEngine`, `WorkflowBuilder`, `WorkflowApi` |
| **Swarm** | `ActoviqSwarmApi`, `ActoviqSwarmTeam`, `ActoviqSwarmTeammateHandle` |
| **Memory** | `ActoviqMemoryApi`, `ActoviqDreamApi` |
| **Storage** | `SessionStore`, `MailboxStore`, `TeammateStore` |
| **Workspace** | `ActoviqWorkspace`, `createGitWorktreeWorkspace` |
| **Bridge** | `ActoviqBridgeSdkClient`, `ActoviqCleanBridgeSdkClient` |
| **Errors** | `ActoviqSdkError`, `ConfigurationError`, `SessionNotFoundError`, etc. |

### Module Dependency Map

```
src/index.ts (public surface)
    │
    ├── config/*          (independent — feeds everything)
    ├── provider/*        (depends on config)
    ├── runtime/*         (depends on config, provider, tools, storage)
    │   ├── agentClient   (central orchestrator)
    │   ├── conversationEngine (ReAct loop)
    │   ├── agentSession  (session wrapper)
    │   ├── actoviqAgents (subagent system)
    │   └── ...
    ├── tools/*           (independent — pure function + Zod)
    ├── storage/*         (independent — JSON file I/O)
    ├── workflow/*        (depends on agentClient)
    ├── swarm/*           (depends on agentClient, storage)
    ├── memory/*          (depends on storage, agentClient)
    ├── workspace/*       (independent — git operations)
    ├── hooks/*           (independent — function composition)
    ├── mcp/*             (depends on @modelcontextprotocol/sdk)
    ├── cli/*, tui/*      (depends on everything above)
    └── parity/*          (depends on agentClient, bridge bundle)
```

### Data Flow: Single `sdk.run()`

```
sdk.run(prompt)
    → createSession()           [SessionStore.create]
    → prepareRunAugmentations() [notifications + memory + system prompt]
    → executeConversation()     [ReAct loop: model ↔ tools]
    → resolveStopHooks()        [post-run hooks]
    → SessionStore.save()       [persist messages]
    → return AgentRunResult     [{ text, toolCalls, requests, usage }]
```

## Code Details

### Entry Point: `createAgentSdk()`

Location: `src/runtime/agentClient.ts:3593`

```typescript
export async function createAgentSdk(
  options: CreateAgentSdkOptions = {},
): Promise<ActoviqAgentClient> {
  const config = await resolveRuntimeConfig(options);
  const store = new SessionStore(config.sessionDirectory);
  const backgroundTaskStore = new BackgroundTaskStore(config.sessionDirectory);
  // ... resolve tools, MCP, agents, skills, hooks ...
  return ActoviqAgentClient.create(config, store, /* ... */);
}
```

Key initialization steps:
1. Resolve config (merge options → env → settings.json → defaults)
2. Create storage layer (SessionStore, BackgroundTaskStore, MailboxStore, TeammateStore)
3. Resolve default tools (core + file + option-provided)
4. Resolve MCP servers
5. Load agent definitions (programmatic + Markdown files)
6. Load skill definitions (bundled + project + user)
7. Create McpConnectionManager
8. Instantiate `ActoviqAgentClient`

### `ActoviqAgentClient` — Surface Area

Location: `src/runtime/agentClient.ts:575` (~3820 lines)

```
ActoviqAgentClient
├── Public API (readonly properties)
│   ├── sessions: AgentSessionsApi      create/resume/list/fork/delete
│   ├── agents: ActoviqAgentsApi         list/get/run/launch background
│   ├── skills: ActoviqSkillsApi         list/get/run/stream
│   ├── tools: ActoviqToolsApi           getTool/listToolMetadata
│   ├── tasks: ActoviqBackgroundTasksApi list/get/wait/cancel
│   ├── buddy: ActoviqBuddyApi           roll personality
│   ├── memory: ActoviqMemoryApi         read/write memories
│   ├── dream: ActoviqDreamApi           trigger consolidation
│   ├── swarm: ActoviqSwarmApi           create/manage swarms
│   ├── context: ActoviqContextApi       overview
│   ├── slashCommands: ActoviqSlashCommandsApi
│   └── workflow: WorkflowApi            DAG engine
│
├── Public methods
│   ├── run(prompt, options?)           One-shot: create session → run → return
│   ├── createSession(options?)         Create persisted session
│   ├── resumeSession(id, options?)     Resume existing session
│   ├── runWithAgent(agent, prompt)     Run with agent definition
│   ├── listToolMetadata()              Tool catalog for UI
│   ├── getTool(name)                   Look up tool by name
│   └── close()                         Cleanup: cancel tasks, dispose MCP
│
├── Private state (shared Maps — coupling risk)
│   ├── pendingDelegations              Map<parentRunId, records[]>
│   ├── pendingRuntimeNotifications     Map<sessionId, notifications[]>
│   ├── subagentInputQueues             Map<agentId, messages[]>
│   └── sessionRuntimeOverrides         Map<sessionId, overrides>
│
└── Configuration
    ├── config: ResolvedRuntimeConfig
    ├── maxSubagentDepth (default 1)
    └── maxSubagentFanout (default 8)
```

### `close()` — Graceful Shutdown

```typescript
async close(): Promise<void> {
  const errors: unknown[] = [];
  try { await this.backgroundTaskManager.cancelAll(); } catch (e) { errors.push(e); }
  try { this.sessionManager.dispose(); }              catch (e) { errors.push(e); }
  try { await this.mcpManager.closeAll(); }           catch (e) { errors.push(e); }
  if (errors.length > 0) throw new AggregateError(errors, '...');
}
```

Each cleanup step runs independently. Failures are collected into an
`AggregateError` — one failing step doesn't block others.

### Design Invariants

1. Hadamard SDK must be fully open-sourceable (no closed-source runtime deps)
2. Tool schemas use `z.strictObject()` → `additionalProperties: false`
3. `tool_use_id` must match between tool_use and tool_result across messages
4. Max tool iterations default to `Infinity` (no artificial cap)
5. Subagent permissions default to `acceptEdits`
