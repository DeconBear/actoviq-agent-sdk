# 05 — Session System

## Architecture

Sessions are the unit of state in Hadamard SDK. Everything — messages, runs,
permissions, metadata, checkpoints — lives inside a `StoredSession` persisted
as JSON on disk.

### Design Rationale

- **Stateless between calls**: load → run → save. Crash recovery is inherent.
- **Human-readable**: JSON files can be inspected, edited, backed up.
- **Workspace-scoped**: `~/.actoviq/projects/<hash>/sessions/<id>.json`
- **No database dependency**: works on any filesystem, portable.

## Module Design

### Files

| File | Role |
|---|---|
| `storage/sessionStore.ts` | JSON file CRUD + checkpoints + atomic writes |
| `runtime/agentSession.ts` | In-memory wrapper with run/stream/compact/dream API |
| `runtime/sessionManager.ts` | Idle timeout, auto-prune, stats |
| `runtime/actoviqSessionPermissions.ts` | Permission state persistence in metadata |

### `AgentSession` — The Wrapper

Location: `src/runtime/agentSession.ts:97`

```
AgentSession
├── Properties (read from stored)
│   ├── id, title, model, messages, metadata, tags
│   └── permissionContext (computed from metadata)
│
├── Execution
│   ├── send(prompt, options?) → AgentRunResult
│   ├── stream(prompt, options?) → AgentRunStream
│   ├── runSkill(name, args?, options?) → AgentRunResult
│   └── streamSkill(name, args?, options?) → AgentRunStream
│
├── State management
│   ├── setModel(model) → void
│   ├── setPermissionContext(context) → void
│   ├── setHooks(hooks) → void
│   ├── rename(title) → void
│   ├── setTags(tags) → void
│   └── mergeMetadata(metadata) → void
│
├── Lifecycle
│   ├── delete() → void
│   ├── fork(options?) → AgentSession
│   └── snapshot() → StoredSession (deep clone)
│
├── Memory & Compaction
│   ├── extractMemory(options?) → MemoryExtractionResult
│   ├── dream(options?) → DreamRunResult
│   ├── compact(options?) → CompactResult
│   ├── compactState(options?) → CompactState
│   └── agentContinuity() → ContinuityState
│
└── Checkpoints
    ├── saveCheckpoint(label) → SessionCheckpoint
    ├── restoreCheckpoint(id) → void
    ├── listCheckpoints() → CheckpointSummary[]
    └── deleteCheckpoint(id) → void
```

### `AgentSessionBindings` Pattern

`AgentSession` doesn't call `ActoviqAgentClient` directly. Instead, it receives
a `bindings` object with callback functions. This avoids circular dependencies
and makes `AgentSession` testable with mock bindings.

```typescript
interface AgentSessionBindings {
  runSession: (session, input, options?) => Promise<AgentRunResult>;
  streamSession: (session, input, options?) => AgentRunStream;
  compactSession: (session, options?) => Promise<CompactResult>;
  // ... 20+ bindings
}
```

### `SessionStore` — Persistence

Location: `src/storage/sessionStore.ts`

```
SessionStore(rootDirectory)
├── create(options?) → StoredSession
├── save(session) → void              [atomic: temp file + rename]
├── load(sessionId) → StoredSession   [throws SessionNotFoundError]
├── list() → SessionSummary[]         [per-file error isolation]
├── delete(sessionId) → void
├── updateStatus(sessionId, status) → void
├── updateLastActiveAt(sessionId) → void
├── fork(sessionId, options) → StoredSession
│
├── saveCheckpoint(sessionId, label) → SessionCheckpoint
├── loadCheckpoint(sessionId, checkpointId) → SessionCheckpoint
├── listCheckpoints(sessionId) → CheckpointSummary[]
└── deleteCheckpoint(sessionId, checkpointId) → void
```

### `SessionManager` — Lifecycle

Location: `src/runtime/sessionManager.ts`

```
SessionManager(store, config?)
├── register(session) → void          [track for timeout/prune]
├── dispose() → void                  [clear timers]
│
├── Auto-prune (configurable):
│   ├── idleTimeoutMs: close sessions inactive > N ms
│   └── maxAgeDays: delete sessions older than N days
│
└── Stats:
    ├── activeCount, idleCount, closedCount
    └── totalCount
```

## Code Details

### `StoredSession` Schema

```typescript
interface StoredSession {
  version: 1;
  id: string;
  title: string;
  titleSource: 'manual' | 'auto';
  model: string;
  systemPrompt?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;       // ISO 8601
  updatedAt: string;
  lastActiveAt: string;
  lastRunAt?: string;
  status: 'active' | 'idle' | 'closed';
  messages: MessageParam[];
  runs: AgentRunRecord[];
}
```

### Atomic Writes

```typescript
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${createId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}
```

Write to temp file first, then atomic rename. Prevents corruption from partial
writes (power loss, disk full, process crash).

### Per-File Error Isolation

```typescript
async list(): Promise<SessionSummary[]> {
  const files = await readdir(this.sessionsDirectory());
  const sessions: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(filePath, 'utf8');
      const session = JSON.parse(raw) as StoredSession;
      sessions.push(this.toSummary(session));
    } catch (error) {
      console.warn(`[SessionStore] Skipping unreadable session ${file}: ${msg}`);
      // Continue — one corrupt file shouldn't hide all other sessions
    }
  }
  return sessions.sort(/* by lastRunAt or updatedAt */);
}
```

Same pattern applied to `listCheckpoints()`.

### Checkpoint Storage

Checkpoints are full session snapshots stored under:
```
~/.actoviq/projects/<hash>/sessions/.checkpoints/<sessionId>/<checkpointId>.json
```

Each checkpoint contains the complete `StoredSession` at the time of creation.
Restoring a checkpoint replaces the session's messages, runs, and metadata.
