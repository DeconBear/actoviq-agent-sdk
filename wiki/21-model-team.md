# 21 — Model Team Multi-Model Cooperation

v0.5.0 multi-model collaboration system with four cooperation modes.
Location: `src/team/*`

## Architecture

Follows the Hadamard Agent Harness principle: **provide scaffolding, not constraints**. Models autonomously decide when to converge, iterate, and accept/reject suggestions.

```
createModelTeam(definition)
    │
    ├── Panel Mode      ── Parallel answers + Primary synthesis
    ├── Router Mode     ── User-configured classifier → specialist dispatch
    ├── Discussion Mode ── Sequential speaking + Facilitator subagent + Primary verdict
    └── Executor-Reviewer ── Executor produces + Reviewer advises + Executor decides
```

## Four Modes

### Panel Mode (Fusion-Style Multi-Round Deliberation)

Multiple models answer the same prompt in parallel. The primary model receives all responses and autonomously decides whether to converge or request another round.

**Key traits**:
- Full primary model autonomy — no similarity thresholds, score cutoffs, or round limits
- Context accumulation — primary sees all prior responses across rounds
- Graceful degradation — member failures return error markers

### Router Mode (User-Configured Dispatch)

User defines categories, models, and system prompts per specialist. Router model classifies and dispatches.

### Discussion Mode (Roundtable)

Sequential speaking per round, each member sees prior speakers. Facilitator subagent summarizes and recommends. Primary makes final decision.

### Executor-Reviewer Mode

Executor produces, Reviewer provides free-text advisory feedback, Executor has final authority.

## Key Features

- **Independent per-member provider config**: model, provider, baseURL, apiKey per member
- **$ENV_VAR resolution**: `apiKey: "$MY_KEY"` resolved at runtime
- **Global AgentPool**: shared concurrency cap across workflows, teams, swarms
- **Team Tool**: wraps team as agent-callable tool with `interruptBehavior: 'block'`
- **Cost tracking**: per-model tokens + estimatedCost via built-in pricing table
- **Team definitions on disk**: `~/.actoviq/teams/` and `.actoviq/teams/`
- **TUI/REPL**: `/team list`, `/team ask <name> <prompt>`

## Integration

```typescript
// Border between panel members
const panel = await sdk.createTeam({
  mode: 'panel',
  members: [
    { model: 'MiniMax-M3', provider: 'anthropic' },
    { model: 'deepseek-v4-pro' },
  ],
  primary: { model: 'deepseek-v4-pro' },
});
const result = await panel.ask('Complex question...');
```

## Design Decisions

- **ADR-6**: Unlimited iterations by default — models decide convergence
- **ADR-7**: Provider-independent per member — each uses resolveRuntimeConfig
- **ADR-8**: Global concurrency pool — shared cap prevents over-subscription
