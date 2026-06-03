# 07. Workflow Orchestration, Parallel, and Checkpoint

This chapter introduces the orchestration layer: workflows (DAG-based multi-step pipelines), parallel primitives, session lifecycle management, and session checkpoints.

## 1. Workflow Orchestration

A **workflow** is a DAG of steps. Each step is an independent ReAct session. Steps connected via `dependsOn` form a DAG — same-level steps execute in parallel.

### 1.0 API Reference

`sdk.workflow` offers two design paths: **Builder DSL** for human-authored TypeScript code, and **direct JSON definition** for agent-authored or machine-generated workflows. Both paths call the same `WorkflowEngine.run()` and produce identical results.

#### Builder DSL

Entry point is `sdk.workflow.define(name, description)`, which returns a `WorkflowBuilder`. All methods support chaining.

**`define(name: string, description?: string): WorkflowBuilder`**

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique workflow identifier; used for logging, events, and session titles. |
| `description` | `string` | No | Workflow purpose, written to session metadata. |

**`param(name: string, definition: WorkflowParameter): this`**

Define a workflow-level parameter, referenced in step prompts via `$PARAM_NAME` (uppercase).

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Parameter name; use `$NAME` (uppercase) in prompts to reference it. |
| `definition.type` | `'string' \| 'number' \| 'boolean' \| 'json'` | Yes | Parameter type. |
| `definition.description` | `string` | Yes | Parameter description. |
| `definition.required` | `boolean` | No | Whether the parameter is required. Default `false`. |
| `definition.default` | `unknown` | No | Default value used when `.run()` is called without it. |

**`model(model: string | null): this`**

Set a default model for all steps. Individual steps can override via `opts.model` in `step()`.

| Param | Type | Required | Description |
|---|---|---|---|
| `model` | `string \| null` | No | Model ID, e.g. `'claude-medium-4-6'`. Pass `null` to clear. |

**`systemPrompt(prompt: string): this`**

Set a default system prompt for all steps. Individual steps can override via `opts.systemPrompt` in `step()`.

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | No | System-level prompt text. |

**`step(id, description, prompt, opts?): this`**

Add a workflow step. This is the core method.

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique step identifier. Used for `dependsOn` references and `$steps.<id>.text` interpolation. |
| `description` | `string` | Yes | Human-readable display name. Used in logs, events (`event.stepName`), session titles, and result lookup. Can be empty `''`. |
| `prompt` | `string` | Yes | Step prompt. Supports three variable interpolations: `$steps.<id>.text`, `$steps.<id>.toolCalls`, and `$PARAM_NAME`. |
| `opts.dependsOn` | `string[]` | No | Step IDs this step depends on. Steps at the same level run in parallel. |
| `opts.allowedTools` | `string[]` | No | Restrict tools available to this step, e.g. `['read', 'grep']`. |
| `opts.tools` | `(string \| AgentToolDefinition)[]` | No | Extra tool definitions for this step. Strings are resolved against the SDK tool registry at runtime. |
| `opts.mcpServers` | `AgentMcpServerDefinition[]` | No | Per-step MCP server list. |
| `opts.skillDirectories` | `string[]` | No | Per-step skill directories to load (merged with global skills). |
| `opts.model` | `string \| null` | No | Per-step model override; takes precedence over global `model()`. |
| `opts.systemPrompt` | `string` | No | Per-step system prompt override; takes precedence over global `systemPrompt()`. |
| `opts.mode` | `'react' \| 'single'` | No | Run mode. `'react'` (default) = full tool-using ReAct loop. `'single'` = one-shot answer, no tool calls. |

**`run(params?, options?): Promise<WorkflowRunResult>`**

Execute the workflow and return results.

| Param | Type | Required | Description |
|---|---|---|---|
| `params` | `Record<string, unknown>` | No | Key-value pairs for workflow parameters defined via `.param()`. |
| `options.onEvent` | `(event: AgentEvent) => void` | No | Event callback; receives `workflow.start`, `step.start`, `step.done`, `workflow.done` events. |
| `options.signal` | `AbortSignal` | No | Abort signal to cancel the entire workflow. |

#### Direct Engine Usage

**`sdk.workflow.run(definition, params?, options?): Promise<WorkflowRunResult>`**

Bypass the Builder DSL and pass a `WorkflowDefinition` object directly. The `definition` shape:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Workflow name. |
| `description` | `string` | Yes | Workflow description. |
| `steps` | `WorkflowStepDefinition[]` | Yes | Step array; each step has `id`, `description`, `prompt`, `dependsOn`, `tools`, `mode`, etc. |
| `parameters` | `Record<string, WorkflowParameter>` | No | Parameter definitions. |
| `model` | `string \| null` | No | Global model. |
| `systemPrompt` | `string` | No | Global system prompt. |

#### Two Design Paths

The Builder DSL and direct JSON definition serve different authors, same engine:

| | Builder DSL | Direct JSON |
|---|---|---|
| **Author** | Human developer | Agent (LLM output) or user who prefers raw JSON |
| **Type safety** | Compile-time (autocomplete, refactoring, error on misspelled step IDs) | Runtime only |
| **Integration** | `sdk.workflow.define(...).step(...).run()` chain | `sdk.workflow.run(definition, params, opts)` one call |
| **Serializable** | Compiles to `WorkflowDefinition` (same shape as JSON) | Already JSON |

Both paths converge at `WorkflowEngine.run()`. The engine processes the same `WorkflowDefinition` type regardless of how it was constructed.

#### Deployment Modes

A workflow can run in two contexts:

**Standalone** — user code explicitly invokes the workflow:

```ts
// Builder
const result = await sdk.workflow.define('release-check', '...')
  .step('lint', 'Run lint', '...').run()

// JSON
const result = await sdk.workflow.run(
  { name: 'release-check', steps: [...] },
  { REPO_PATH: '/home/user/project' },
)
```

**Embedded in a subagent** — the workflow definition is loaded as part of an agent definition. The main agent triggers it via tool calls or skill invocation:

```ts
const sdk = await createAgentSdk({
  agents: [{
    name: 'release-bot',
    description: 'Automated release checklist runner',
    // The subagent can call sdk.workflow.run() internally
  }],
})
```

In both modes, each step creates an independent session. Steps can be resumed individually via `resumeSession(step.sessionId)` regardless of which context launched them.

#### Return Value `WorkflowRunResult`

| Field | Type | Description |
|---|---|---|
| `runId` | `string` | Unique run identifier. |
| `workflowName` | `string` | Workflow name. |
| `steps` | `WorkflowStepResult[]` | Results for all steps, in definition order. |
| `text` | `string` | Text output from the last successful step. |
| `durationMs` | `number` | Total wall-clock duration in milliseconds. |
| `status` | `'completed' \| 'partial' \| 'failed'` | All succeeded / some succeeded / all failed. |

`WorkflowStepResult` fields:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Step ID. |
| `name` | `string` | Step name. |
| `status` | `'completed' \| 'failed' \| 'skipped'` | Step outcome. Dependent steps are `skipped` when a predecessor fails. |
| `text` | `string` | Text output from the step. |
| `toolCalls` | `string[]` | Names of tools called by this step. |
| `durationMs` | `number` | Step duration in milliseconds. |
| `sessionId` | `string` | Session ID for this step; usable with `resumeSession()` for recovery. |
| `error` | `string?` | Error message if the step failed. |

### 1.1 Step-by-Step Walkthrough

The following walks through `examples/actoviq-workflow-annotated.ts` — a complete example that uses every API method with detailed annotations. Open that file alongside this section for the full picture.

**Scenario: pre-release check on a specific Git repo.** Requirements: repo path and branch name are caller-supplied, step 1 is read-only, step 2 depends on step 1, step 3 uses a faster model for summarization.

> Run it: `npm run example:actoviq-workflow-annotated`

---

**Step 1: `sdk.workflow.define(name, description)` — create the workflow**

```ts
.define('release-check', 'Pre-release typecheck and lint for a target repo')
```

Two simple parameters:

- `name` = `'release-check'` — this string appears in three places: `event.workflowName` in event callbacks, each step's session title (`"release-check/Type Check"`), and `result.workflowName`. **Pick a descriptive, kebab-case ID.**
- `description` — documentation only; written to session metadata.

---

**Step 2: `.param(name, definition)` — define external parameters**

```ts
.param('REPO_PATH', {
  type: 'string',
  description: 'Local path to the repository',
  required: true,
})
.param('BRANCH', {
  type: 'string',
  description: 'Target branch name',
  default: 'main',
})
```

**Why param?** Without it, repo paths would be hardcoded in prompts — the workflow wouldn't be reusable. With params, the same workflow runs against any repo.

Field-by-field:

- `name` = `'REPO_PATH'` — referenced in step prompts as `$REPO_PATH`. **Must be UPPERCASE** — the variable resolver only matches `$` followed by an uppercase letter.
- `definition.type` = `'string'` — tells the system this is a string. Options: `string` / `number` / `boolean` / `json`.
- `definition.description` — documentation only.
- `definition.required` = `true` — calling `.run()` without `REPO_PATH` throws an error. It has no default, so omitting it is invalid.
- `definition.default` — `BRANCH` defaults to `'main'`. Callers can omit it.

---

**Step 3: `.model(model)` and `.systemPrompt(prompt)` — global defaults**

```ts
.model('claude-medium-4-6')
.systemPrompt('You are a DevOps engineer. Report results only, no conversation. Language: English.')
```

These set **global fallbacks** — every step inherits them, but individual steps can override via `opts.model` / `opts.systemPrompt`.

- `model` — set once when most steps share the same model. Override per-step for exceptions (see the report step below).
- `systemPrompt` — shared constraints like role, language, output format.

---

**Step 4: `.step(id, description, prompt, opts?)` — the core method**

Every `.step()` call adds one step to the DAG. Let's break down each of the three steps.

**Step A: typecheck**

```ts
.step(
  'typecheck',       // ① id
  'Type Check',      // ② description — display name, appears in event.stepName and session titles
  'Run tsc --noEmit on the repo at $REPO_PATH, checking branch $BRANCH for type errors.',  // ③ prompt
  { allowedTools: ['read', 'glob', 'grep'] },  // ④ opts
)
```

Parameter walkthrough:

- ① **`id` = `'typecheck'`** — unique step identifier. **Three critical uses:**
  - Other steps reference it via `dependsOn: ['typecheck']`
  - Later steps read its output via `$steps.typecheck.text`
  - Result lookup: `result.steps.find(s => s.id === 'typecheck')`
  - **Naming: short, lowercase, hyphenated.**

- ② **`description` = `'Type Check'`** — human-facing display name. Appears in `event.stepName` and session titles (format: `"release-check/Type Check"`). Can contain spaces and non-ASCII characters.

- ③ **`prompt`** — **this is the actual text sent to the AI model.** `$REPO_PATH` and `$BRANCH` are replaced with values from `.run()` at execution time.

- ④ **`opts.allowedTools`** — restricts this step to read-only tools (`read`, `glob`, `grep`). Type checking should never write files. **No `dependsOn` means the step runs immediately** (empty dependency list).

**Step B: lint**

```ts
.step(
  'lint',
  'Lint',
  'Run ESLint on $REPO_PATH at branch $BRANCH. Typecheck results for context: $steps.typecheck.text',
  { dependsOn: ['typecheck'] },  // ← key: declares dependency
)
```

Key differences from step A:

- **`prompt` includes `$steps.typecheck.text`** — replaced at runtime with step A's actual output. This gives the lint step access to typecheck findings.
- **`opts.dependsOn: ['typecheck']`** — **declares execution ordering.** This means:
  1. Lint only runs after typecheck completes
  2. If typecheck fails, lint is automatically skipped
  3. `$steps.typecheck.text` is only valid when typecheck succeeds
- **No `allowedTools`** — inherits SDK default permissions.
- **No `model`** — inherits the global `.model('claude-medium-4-6')`.

**Step C: report**

```ts
.step(
  'report',
  'Report',
  'Generate a pre-release report for branch $BRANCH:\n'
    + 'Type check: $steps.typecheck.text\n'
    + 'Lint: $steps.lint.text',
  {
    dependsOn: ['typecheck', 'lint'],  // depends on two steps
    model: 'claude-min-4-5',          // overrides global model
    systemPrompt: 'You are a report generator. Output only markdown, no conversation.',
    mode: 'single',                     // one-shot answer, no tool calls needed for report gen
  },
)
```

What's different:

- **`dependsOn: ['typecheck', 'lint']`** — waits for both. Since lint already depends on typecheck, the actual execution order is: typecheck → lint → report. **Same-level steps run in parallel — if another step also only depended on typecheck, it would run concurrently with lint.**
- **`model: 'claude-min-4-5'`** — overrides the global model. Report summarization doesn't need deep reasoning; a faster model saves time and cost.
- **`systemPrompt`** — overrides the global prompt. The report step needs markdown formatting, unlike the "DevOps engineer" role required by earlier steps.
- **`mode: 'single'`** — the report step only generates text, no tools needed. `'single'` mode sets `toolChoice: { type: 'none' }`, producing a single answer without the ReAct tool loop. Default is `'react'`.

---

**Step 5: `.run(params, options?)` — execute**

```ts
.run(
  { REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' },
  {
    onEvent: (event: AgentEvent) => {
      switch (event.type) {
        case 'workflow.start': /* event.workflowName, event.stepCount */ break;
        case 'step.start':    /* event.stepName */                 break;
        case 'step.done':     /* event.stepId, status, durationMs */ break;
        case 'workflow.done': /* event.status, durationMs */       break;
      }
    },
  },
)
```

Everything before `.run()` was just **declaring** the workflow structure. `.run()` actually executes it.

- **First argument `params`** — key-value pairs for the `.param()` definitions. `REPO_PATH` is required; `BRANCH` could be omitted (defaults to `'main'`). These values replace `$REPO_PATH` and `$BRANCH` in every step's prompt.
- **Second argument `options.onEvent`** — event callback. Four event types fire during execution for progress display and logging. The callback is a side-channel listener; it does not affect execution.

---

**Reading the result:**

```ts
result.status       // 'completed' | 'partial' | 'failed'
result.steps        // all step results, in definition order
result.text         // text from the last successful step (report)
result.durationMs   // total wall-clock duration
```

Per-step fields:

```ts
step.id          // 'typecheck' | 'lint' | 'report'
step.name        // 'Type Check' | 'Lint' | 'Report'  (the description field)
step.status      // 'completed' | 'failed' | 'skipped'
step.text        // the AI's text output for this step
step.toolCalls   // tool names called by this step
step.durationMs  // step duration
step.sessionId   // session ID — use with resumeSession() to retry on failure
step.error       // error message (only when status === 'failed')
```

**Failure recovery:**

```ts
const failed = result.steps.find(s => s.status === 'failed');
if (failed) {
  const session = await sdk.resumeSession(failed.sessionId);
  await session.send('Previous attempt failed. Please retry.');
}
```

Each step is independently persisted. On failure, resume from its `sessionId` and retry — other successful steps are unaffected.

### 1.2 Agent-Orchestrated Workflows

Instead of writing a Builder script, you can let an Agent design and execute a workflow autonomously. The Agent receives a high-level task, produces a `WorkflowDefinition` JSON, and submits it via a custom tool.

**How it works:**

1. Define a `run_workflow` custom tool using the `tool()` helper with a Zod schema
2. The tool closure captures the SDK instance
3. The Agent calls `run_workflow` with a JSON workflow definition
4. The tool executes `sdk.workflow.run()` and returns formatted results

This pattern connects the two design paths: the Agent writes the JSON, and the engine executes it — exactly the same path as a human-written JSON workflow.

**Run the example:**

```bash
npm run example:actoviq-workflow-agent-orchestration
```

**Key code — creating the `run_workflow` tool:**

```ts
import { tool, z } from 'actoviq-agent-sdk';

function createRunWorkflowTool(sdk) {
  return tool(
    {
      name: 'run_workflow',
      description: 'Execute a multi-step workflow from a JSON definition...',
      inputSchema: z.object({
        definition: z.record(z.string(), z.unknown())
          .describe('The complete WorkflowDefinition object.'),
        params: z.record(z.string(), z.string()).optional()
          .describe('Workflow parameters as key-value pairs.'),
      }),
    },
    async (input) => {
      const definition = input.definition;
      const params = input.params ?? {};
      return await sdk.workflow.run(definition, params, { onEvent });
    },
  );
}
```

**Agent session setup:**

```ts
const sdk = await createAgentSdk({ workDir: process.cwd() });
const runWorkflowTool = createRunWorkflowTool(sdk);

const session = await sdk.createSession({
  title: 'Workflow Orchestrator',
  systemPrompt: 'Design a workflow JSON and call run_workflow ONCE.',
});

await session.send(taskPrompt, {
  tools: [runWorkflowTool],
  permissionMode: 'bypassPermissions',  // allow Agent to call custom tools
});
```

**Variable interpolation works the same way** — `$steps.<id>.text` and `$steps.<id>.toolCalls` in step prompts are resolved from previous step outputs automatically.

This pattern is especially powerful when:
- The task is dynamic (the Agent inspects the repo first, then designs steps)
- You're building a meta-agent that delegates to sub-workflows
- You want end users to describe tasks in natural language rather than code

For the full runnable example, see [`examples/actoviq-workflow-agent-orchestration.ts`](https://github.com/DeconBear/actoviq-agent-sdk/blob/main/examples/actoviq-workflow-agent-orchestration.ts).

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
    () => sdk.run('What is 2+2?', { model: 'claude-min-4-5' }),
    () => sdk.run('What is 2+2?', { model: 'claude-medium-4-6' }),
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
    maxConcurrentActive: 10,        // Reserved; not enforced yet
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
npm run example:actoviq-workflow-annotated  # Fully annotated workflow walkthrough (start here)
npm run example:actoviq-workflow            # Workflow basics
npm run example:actoviq-parallel            # Parallel & race primitives
npm run example:actoviq-session-manager     # Session lifecycle management
npm run example:actoviq-checkpoint          # Session checkpoints
```

---

Next chapter:

- [Back to Index](./index.md)
