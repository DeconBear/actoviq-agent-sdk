# 14 — Swarm System

## Architecture

The Swarm system provides long-lived multi-agent collaboration through a
mailbox communication pattern. Unlike subagents (fire-and-forget or
fire-and-wait), Swarm teammates persist across interactions and exchange
messages asynchronously.

Location: `src/swarm/actoviqSwarm.ts`

### Swarm vs Subagents

| | Subagents | Swarm |
|---|---|---|
| **Lifetime** | Single task, then terminate | Persist across multiple interactions |
| **Communication** | Input → output (one-shot) | Mailbox (asynchronous message passing) |
| **Coordination** | Parent orchestrates | Lead agent supervises peers |
| **State** | Session-only | Persistent teammate state |
| **Use case** | Delegate a task | Collaborate over time |

## Module Design

### Files

| File | Role |
|---|---|
| `swarm/actoviqSwarm.ts` | Swarm API, Team, TeammateHandle |
| `storage/mailboxStore.ts` | Mailbox persistence (JSON files) |
| `storage/teammateStore.ts` | Teammate persistence (JSON files) |

### Core Concepts

```
ActoviqSwarmApi
    │
    ├── createTeam(name, config) → ActoviqSwarmTeam
    │       │
    │       ├── teammates: ActoviqSwarmTeammateHandle[]
    │       │   ├── Each has own session + model
    │       │   ├── send(message) → void (to mailbox)
    │       │   └── receive() → message[] (from mailbox)
    │       │
    │       ├── lead: ActoviqSwarmTeammateHandle
    │       │   └── Supervises, coordinates, resolves conflicts
    │       │
    │       └── mailbox: shared message queue
    │
    └── listTeams() → ActoviqSwarmTeam[]
```

### Mailbox Pattern

```
Teammate A                    Mailbox                    Teammate B
    │                            │                           │
    │── send(msg to B) ────────▶│                           │
    │                            │── store message          │
    │                            │                           │
    │                            │                           │── receive() ──▶
    │                            │                           │   reads msg
    │                            │                           │
    │                            │                           │── send(reply) ──▶
    │                            │── store reply             │
    │                            │                           │
    │── receive() ──────────────▶│                           │
    │   reads reply              │                           │
```

## Code Details

### `ActoviqSwarmApi`

```typescript
class ActoviqSwarmApi {
  constructor(
    private readonly store: MailboxStore,
    private readonly teammateStore: TeammateStore,
    private readonly createSession: (options) => Promise<AgentSession>,
  ) {}

  async createTeam(name: string, config: SwarmTeamConfig): Promise<ActoviqSwarmTeam> {
    // Create sessions for each teammate
    // Initialize mailbox
    // Return team handle
  }

  async listTeams(): Promise<ActoviqSwarmTeamSummary[]> {
    // Scan teammateStore
  }
}
```

### `ActoviqSwarmTeammateHandle`

```typescript
class ActoviqSwarmTeammateHandle {
  constructor(
    readonly name: string,
    readonly session: AgentSession,
    private readonly mailbox: MailboxStore,
  ) {}

  async send(to: string, message: string): Promise<void> {
    await this.mailbox.send({
      from: this.name,
      to,
      message,
      timestamp: nowIso(),
    });
  }

  async receive(): Promise<MailboxMessage[]> {
    return this.mailbox.receive(this.name);
  }

  async run(prompt: string): Promise<AgentRunResult> {
    // Check mailbox for pending messages
    // Inject into system prompt
    // Run conversation
    // Process any sent messages
    return this.session.send(prompt);
  }
}
```

### `MailboxStore`

Location: `src/storage/mailboxStore.ts`

```typescript
class MailboxStore {
  async send(msg: MailboxMessage): Promise<void> { /* persist to JSON */ }
  async receive(teammateName: string): Promise<MailboxMessage[]> { /* read + mark delivered */ }
  async list(teammateName: string): Promise<MailboxMessage[]> { /* all messages */ }
}
```
