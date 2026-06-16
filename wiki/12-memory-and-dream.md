# 12 — Memory & Dream

## Architecture

The memory system provides persistent, context-aware knowledge across sessions.
The dream system performs reflective consolidation — periodically reviewing
recent sessions and extracting durable memories.

Location: `src/memory/actoviqMemory.ts`, `src/memory/actoviqDream.ts`

### Design Principles

- **File-based**: memories are individual Markdown files with frontmatter
- **Typed**: `user` | `project` | `feedback` | `reference` memory types
- **Freshness-tracked**: each memory has age metadata; stale memories surface
  with lower priority
- **Dream = consolidation**: a dedicated model pass over recent sessions to
  extract, update, and prune memories

## Module Design

### Files

| File | Role |
|---|---|
| `memory/actoviqMemory.ts` | Memory CRUD, scanning, selection, formatting |
| `memory/actoviqDream.ts` | Dream consolidation engine |
| `memory/actoviqSessionMemoryState.ts` | Session memory extraction & runtime state |

### Memory Storage Layout

```
~/.actoviq/projects/<hash>/memory/
├── MEMORY.md                 # Index of all memories (one line per memory)
├── user-expertise.md         # Individual memory file
├── project-architecture.md
├── feedback-prefer-x.md
└── reference-api-docs.md
```

### Memory File Format

```markdown
---
name: user-expertise
description: User is a senior TypeScript developer
metadata:
  type: user
---

The user is a senior TypeScript developer with expertise in agent systems.
**Why:** Determined from conversation patterns.
**How to apply:** Use TypeScript-idiomatic patterns; avoid explaining basics.
```

### Memory Types

| Type | Purpose | Example |
|---|---|---|
| `user` | Who the user is | Role, expertise, preferences |
| `project` | Ongoing work, goals | Architecture decisions, constraints |
| `feedback` | User guidance on how to work | "Always use Zod for validation" |
| `reference` | External resources | URLs, dashboards, tickets |

### Memory Selection

When preparing a model request, relevant memories are selected based on:
1. Keyword match against the current prompt and conversation
2. Recency (fresher memories ranked higher)
3. Type priority (feedback > user > project > reference)

```typescript
function selectActoviqRelevantMemories(
  memories: ActoviqMemory[],
  context: string,
  limit: number = 5,
): ActoviqMemory[] {
  // Score each memory by keyword relevance
  // Sort by relevance × freshness
  // Return top-N
}
```

### Dream Process

```
Dream Trigger (auto or manual via /dream)
    │
    ▼
1. Lock acquisition (prevents concurrent dreams)
    tryAcquireActoviqConsolidationLock()
    │
    ▼
2. Identify sessions since last consolidation
    listActoviqSessionsTouchedSince(lastConsolidatedAt)
    │
    ▼
3. For each session, extract memory-worthy content
    • User preferences expressed
    • Project decisions made
    • Feedback given
    │
    ▼
4. Run consolidation model pass
    • Read existing memories
    • Review session summaries
    • Create new memories
    • Update conflicting memories
    • Prune obsolete memories
    │
    ▼
5. Write updated MEMORY.md + memory files
    │
    ▼
6. Record consolidation timestamp
    recordActoviqConsolidation()
    │
    ▼
7. Release lock
```

## Code Details

### `ActoviqMemoryApi`

Location: `src/memory/actoviqMemory.ts:466`

```typescript
class ActoviqMemoryApi {
  async list(type?: string): Promise<ActoviqMemory[]> { /* scan directory */ }
  async read(name: string): Promise<ActoviqMemory | undefined> { /* read file */ }
  async write(memory: ActoviqMemory): Promise<void> { /* write file + update index */ }
  async delete(name: string): Promise<void> { /* delete file + update index */ }
  async selectRelevant(context: string, limit?: number): Promise<ActoviqMemory[]> { /* keyword match */ }
}
```

### `ActoviqDreamApi`

Location: `src/memory/actoviqDream.ts:50`

```typescript
class ActoviqDreamApi {
  async run(options?: ActoviqDreamOptions): Promise<ActoviqDreamResult> {
    // Full dream consolidation cycle
  }
  
  async isEligible(session: StoredSession): Promise<boolean> {
    // Check: enough new content since last dream?
  }
  
  async getState(): Promise<ActoviqDreamState> {
    // Last consolidation, pending sessions, etc.
  }
}
```

### Memory Freshness Metadata

```typescript
function getActoviqMemoryAge(createdAt: string): number {
  return Date.now() - new Date(createdAt).getTime();
}

function getActoviqMemoryFreshnessNote(ageMs: number): string {
  if (ageMs < 3600000) return ' (created < 1 hour ago)';
  if (ageMs < 86400000) return ` (created ${Math.round(ageMs / 3600000)}h ago)`;
  return ` (created ${Math.round(ageMs / 86400000)}d ago)`;
}
```

### Auto-Dream Triggers

Dream can be triggered:
1. **Manually**: `/dream` slash command or `session.dream({ force: true })`
2. **Automatically**: after N runs, if enough new content since last consolidation
3. **On session close**: if `autoDreamOnClose` is enabled

### Dream Lock

A file-based lock (`dream.lock`) prevents concurrent dream processes from
corrupting memory files. If the lock is stale (older than lock timeout), it's
broken and re-acquired.
