# 07. Workflow Orchestration, Parallel, and Checkpoint

This chapter introduces the orchestration layer: workflows (DAG-based multi-step pipelines), parallel primitives, session lifecycle management, and session checkpoints.

## 1. Workflow Orchestration

A **workflow** is a DAG of steps. Each step is an independent ReAct session. Steps connected via `dependsOn` form a DAG — same-level steps execute in parallel.

### 1.1 Basic Workflow

```ts
import { createAgentSdk } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk();

const result = await sdk.workflow
  .define('code-review', 'Automated code review pipeline')
  .step('typecheck', 'Type Check', 'Run type checking', 'Run tsc --noEmit on the project.')
  .step(
    'lint',
    'Lint',
    'Run linter',
    'Run ESLint, using typecheck results: $steps.typecheck.text',
    { dependsOn: ['typecheck'] },
  )
  .step(
    'report',
    'Report',
    'Generate report',
    'Combine typecheck ($steps.typecheck.text) and lint ($steps.lint.text) results.',
    { dependsOn: ['typecheck', 'lint'] },
  )
  .run();

console.log(result.status); // 'completed' | 'partial' | 'failed'
for (const step of result.steps) {
  console.log(`${step.id}: ${step.status} (${step.durationMs}ms)`);
}
```

### 1.2 Variable Interpolation

Workflows support two kinds of variable interpolation in step prompts:

| Syntax | Meaning | Example |
|---|---|---|
| `$steps.<id>.text` | Text output of a previous step | `$steps.typecheck.text` |
| `$steps.<id>.toolCalls` | Tool names called by a previous step | `$steps.build.toolCalls` |
| `$PARAM_NAME` | Workflow-level parameter (uppercase) | `$REPO_PATH`, `$BRANCH` |

### 1.3 Workflow Parameters

```ts
const result = await sdk.workflow
  .define('release-check', 'Pre-release checklist')
  .param('REPO_PATH', {
    type: 'string',
    description: 'Path to the repository',
    required: true,
  })
  .param('BRANCH', {
    type: 'string',
    description: 'Target branch name',
    default: 'main',
  })
  .step(
    'checkout',
    'Checkout',
    'Checkout the target branch',
    'Navigate to $REPO_PATH and checkout branch $BRANCH.',
  )
  .run({ REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' });
```

### 1.4 Tool Restrictions per Step

Limit which tools a step can use:

```ts
const result = await sdk.workflow
  .define('safe-read', 'Read-only analysis')
  .step(
    'analyze',
    'Analyze',
    'Read-only analysis',
    'Read and analyze project files.',
    { allowedTools: ['read', 'glob', 'grep'] },
  )
  .run();
```

### 1.5 Per-Step Model

Each step can use a different model:

```ts
sdk.workflow
  .define('multi-model', 'Multi-model workflow')
  .step(
    'quick',
    'Quick Check',
    'Fast initial scan',
    'Quickly scan the project.',
    { model: 'claude-haiku-4-5' },
  )
  .step(
    'deep',
    'Deep Analysis',
    'Thorough analysis',
    'Do a deep analysis based on: $steps.quick.text',
    { model: 'claude-sonnet-4-6', dependsOn: ['quick'] },
  )
  .run();
```

### 1.6 Workflow Events

Subscribe to workflow-level events via `onEvent`:

```ts
import type { AgentEvent } from 'actoviq-agent-sdk';

const result = await sdk.workflow.run(
  definition,
  params,
  {
    onEvent: (event: AgentEvent) => {
      switch (event.type) {
        case 'workflow.start':
          console.log(`Started: ${event.workflowName} (${event.stepCount} steps)`);
          break;
        case 'step.start':
          console.log(`Step started: ${event.stepName}`);
          break;
        case 'step.done':
          console.log(`Step done: ${event.stepId} → ${event.status} (${event.durationMs}ms)`);
          break;
        case 'workflow.done':
          console.log(`Workflow done: ${event.workflowName} → ${event.status}`);
          break;
      }
    },
  },
);
```

### 1.7 Using WorkflowEngine Directly

If the builder DSL doesn't fit, use the engine directly:

```ts
const result = await sdk.workflow.run({
  name: 'custom-workflow',
  description: 'Custom pipeline',
  steps: [
    { id: 'a', name: 'A', description: 'Step A', prompt: 'Do A.', dependsOn: [] },
    { id: 'b', name: 'B', description: 'Step B', prompt: 'Based on $steps.a.text, do B.', dependsOn: ['a'] },
  ],
});
```

### 1.8 Error Handling & Resume

Each step is independently persisted. When a step fails, you can resume from its session:

```ts
const result = await sdk.workflow.run(definition);
const failedStep = result.steps.find(s => s.status === 'failed');
if (failedStep) {
  const session = await sdk.resumeSession(failedStep.sessionId);
  await session.send('The previous attempt failed. Please retry with more care.');
}
```

---

## 2. Parallel Primitives

`parallel()` and `race()` are independent of workflows — use them for any concurrent tasks.

### 2.1 `parallel()`

Run multiple tasks concurrently with configurable concurrency:

```ts
const results = await sdk.parallel(
  [
    () => sdk.run('Summarize the project.'),
    () => sdk.run('List action items.'),
    () => sdk.run('Review code structure.'),
  ],
  { maxConcurrency: 3 },
);

console.log(results[0]?.text);
console.log(results[1]?.text);
console.log(results[2]?.text);
```

Options:

| Option | Default | Description |
|---|---|---|
| `maxConcurrency` | `5` | Maximum tasks running simultaneously |
| `failFast` | `false` | Stop all tasks on first failure |
| `signal` | — | `AbortSignal` to cancel execution |

### 2.2 `race()`

Run tasks and return the first to complete:

```ts
const fastest = await sdk.race(
  [
    () => sdk.run('What is 2+2?', { model: 'claude-haiku-4-5' }),
    () => sdk.run('What is 2+2?', { model: 'claude-sonnet-4-6' }),
  ],
  { timeoutMs: 30_000 },
);

console.log(fastest.text);
```

Options:

| Option | Default | Description |
|---|---|---|
| `timeoutMs` | — | Max wait time before throwing |
| `signal` | — | `AbortSignal` to cancel execution |

---

## 3. Session Lifecycle Management

The `SessionManager` provides lifecycle management for sessions: idle timeout, cleanup, and stats.

### 3.1 Configuration

```ts
const sdk = await createAgentSdk({
  sessionManager: {
    idleTimeoutMs: 30 * 60_000,    // Mark idle after 30 min (default)
    maxSessions: 100,               // Max stored sessions
    maxConcurrentActive: 10,        // Max concurrent active sessions
    cleanupIntervalMs: 5 * 60_000,  // Auto-cleanup interval (default: 5 min)
  },
});
```

### 3.2 Session States

| State | Meaning |
|---|---|
| `active` | Session was recently used (touched by `send`/`stream`) |
| `idle` | Inactive beyond `idleTimeoutMs` |
| `closed` | Explicitly closed via `closeIdle()` |

### 3.3 Managing Sessions

```ts
// Get session stats
const stats = await sdk.sessions.stats();
console.log(stats); // { total, active, idle, closed }

// Prune closed sessions older than 7 days
await sdk.sessions.prune({ status: 'closed', olderThan: '7d' });

// Prune idle sessions older than 1 hour
await sdk.sessions.prune({ status: 'idle', olderThan: '1h' });

// Close all idle sessions
const closed = await sdk.sessions.closeIdle();
console.log(`Closed ${closed} sessions`);
```

### 3.4 How `touch()` Works

Every `session.send()` call automatically touches the session, resetting its idle timer and updating `lastActiveAt`. No manual calls needed.

---

## 4. Session Checkpoints

Checkpoints let you save and restore session state — useful before risky refactors or for exploring alternative approaches.

### 4.1 Save and Restore

```ts
const session = await sdk.createSession({ title: 'Checkpoint Demo' });

await session.send('Remember: the API runs on port 8080.');
await session.send('The database schema is in db/schema.sql.');

// Save a checkpoint
const cp = await session.saveCheckpoint('before-refactor');
console.log(`Checkpoint: ${cp.id}`);

// Do something risky
await session.send('Rename all API endpoints from /api to /v2.');

// Oops, restore
await session.restoreCheckpoint(cp.id);

// Verify — the rename conversation is gone
const reply = await session.send('What port does the API run on?');
console.log(reply.text); // includes "8080"
```

### 4.2 Multiple Checkpoints

```ts
// Save a baseline
const baseline = await session.saveCheckpoint('baseline');

// Try approach A
await session.send('Write a class-based React component.');
const approachA = await session.saveCheckpoint('approach-a');

// Go back and try approach B
await session.restoreCheckpoint(baseline.id);
await session.send('Write a hooks-based React component.');
const approachB = await session.saveCheckpoint('approach-b');
```

### 4.3 Managing Checkpoints

```ts
// List all checkpoints for a session
const checkpoints = await session.listCheckpoints();
for (const cp of checkpoints) {
  console.log(`${cp.id} | "${cp.label}" | ${cp.createdAt}`);
}

// Delete a checkpoint
await session.deleteCheckpoint('checkpoint-id');
```

---

## 5. Complete Example

Run the examples to see everything in action:

```bash
npm run example:workflow
npm run example:parallel
npm run example:session-manager
npm run example:checkpoint
```

---

Next chapter:

- [Back to Index](./index.md)
