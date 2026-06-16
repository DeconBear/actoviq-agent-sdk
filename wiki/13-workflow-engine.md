# 13 — Workflow Engine (DAG)

## Architecture

The DAG workflow engine executes declarative, JSON-defined workflows where
steps have explicit dependencies. It uses topological sorting to determine
execution order and runs independent steps in parallel within each level.

Location: `src/workflow/workflowEngine.ts`, `src/workflow/workflowBuilder.ts`

### Relationship to Dynamic Workflows

The DAG engine (`WorkflowEngine`) is the **declarative** workflow system
(v0.2.0). Dynamic Workflows (planned v0.5.0) will be the **script-based**
system. Both will coexist — DAG for simple static graphs, Dynamic for
programmatic orchestration. See `plan/WORKFLOWS_WORKTREES_MODELTEAM_PLAN_15Jun2026.md`.

## Module Design

### Files

| File | Role |
|---|---|
| `workflow/workflowEngine.ts` | Topological sort + parallel level execution |
| `workflow/workflowBuilder.ts` | Fluent DSL (`define().step().step().run()`) |
| `workflow/types.ts` | `WorkflowDefinition`, `WorkflowStepDefinition`, etc. |

### Workflow Definition

```typescript
interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  parameters?: Record<string, WorkflowParameter>;
  model?: string | null;
  systemPrompt?: string;
}

interface WorkflowStepDefinition {
  id: string;                    // Unique within workflow
  description: string;           // Display name
  prompt: string;                // Template with $variable interpolation
  tools?: (string | AgentToolDefinition)[];
  mcpServers?: AgentMcpServerDefinition[];
  allowedTools?: string[];       // Tool allowlist for this step
  model?: string | null;         // Per-step model override
  systemPrompt?: string;
  mode?: 'react' | 'single';     // 'react' = full loop, 'single' = no tools
  dependsOn: string[];           // Step IDs this step depends on
  retries?: number;              // Retry on failure
  timeoutMs?: number;            // Per-step timeout
}
```

### Execution Flow

```
workflowEngine.run(definition, params, options)
    │
    ├── 1. Resolve parameters
    │      • Apply defaults for missing params
    │      • Type coercion (string/number/boolean/json)
    │      • Error on missing required params
    │
    ├── 2. Topological sort
    │      • Build dependency graph
    │      • Kahn's algorithm: BFS from zero-dependency nodes
    │      • Group into levels (all nodes at same BFS depth)
    │      • Detect cycles → throw
    │
    ├── 3. Execute level by level
    │      for each level:
    │        ├── Filter: skip steps whose dependencies failed
    │        ├── Emit step.start events for runnable steps
    │        ├── Promise.all(runnable steps)
    │        │   └── Each step:
    │        │       ├── Variable interpolation ($steps.X.text, $PARAM_NAME)
    │        │       ├── Create session (reuse on retry)
    │        │       ├── Execute session.send(prompt, { tools, model, ... })
    │        │       ├── Retry on failure (up to step.retries)
    │        │       └── Emit step.done event
    │        └── Mark failed steps (dependents will be skipped)
    │
    ├── 4. Aggregate results
    │      ├── completed: all steps passed
    │      ├── partial: some passed, some failed
    │      └── failed: all failed or skipped
    │
    └── 5. Return WorkflowRunResult
```

### Variable Interpolation

```typescript
function resolveVariables(
  prompt: string,
  params: Record<string, unknown>,
  previousResults: Map<string, WorkflowStepResult>,
): string {
  // $steps.<id>.text → previous step's output text
  // $steps.<id>.toolCalls → comma-separated tool call names
  // $PARAM_NAME → workflow parameter value (uppercase + underscores + digits)
  return result;
}
```

### Retry & Timeout

Steps can declare `retries` (default 0) and `timeoutMs`. On failure:
1. Retry up to `retries` times using the same session
2. Each retry sends the same prompt to the same session (context preserved)
3. Per-step `AbortSignal.timeout()` enforces timeout

### Step Modes

| Mode | Tool Behavior | Use Case |
|---|---|---|
| `react` (default) | Full ReAct loop with tools | Code changes, research, debugging |
| `single` | `tool_choice: "none"`, one-shot answer | Classification, summarization |

## Code Details

### `WorkflowEngine.run()`

```typescript
async run(
  definition: WorkflowDefinition,
  params: Record<string, unknown>,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const levels = topologicalSort(definition.steps);
  const stepResults = new Map<string, WorkflowStepResult>();
  const failedIds = new Set<string>();

  for (const level of levels) {
    const runnable = level.filter(s => !s.dependsOn?.some(d => failedIds.has(d)));
    const skipped = level.filter(s => s.dependsOn?.some(d => failedIds.has(d)));

    // Mark skipped steps
    for (const step of skipped) {
      stepResults.set(step.id, {
        status: 'skipped',
        error: 'Skipped because a dependency failed',
        // ...
      });
    }

    // Run all independent steps in parallel
    const results = await Promise.all(
      runnable.map(step => this.executeStep(step, definition, params, stepResults, runId, options))
    );

    for (const r of results) {
      stepResults.set(r.id, r);
      if (r.status === 'failed') failedIds.add(r.id);
    }
  }

  return { steps: [...stepResults.values()], status: aggregateStatus(/* ... */), /* ... */ };
}
```

### `WorkflowBuilder` — Fluent DSL

```typescript
class WorkflowBuilder {
  step(id: string, description: string, prompt: string, opts?: StepOptions): this {
    this.steps.push({ id, description, prompt, dependsOn: opts?.dependsOn ?? [], /* ... */ });
    return this;
  }

  param(name: string, def: WorkflowParameter): this { /* ... */ return this; }
  model(model: string | null): this { /* ... */ return this; }
  systemPrompt(prompt: string): this { /* ... */ return this; }

  async run(params?: Record<string, unknown>, options?: Partial<WorkflowRunOptions>): Promise<WorkflowRunResult> {
    return this.engine.run({ name, description, steps, parameters, model, systemPrompt }, params, options);
  }
}
```

Usage:
```typescript
await sdk.workflow
  .define('release-check', 'Verify release readiness')
  .step('test', 'Run tests', 'Run the test suite and report results.')
  .step('lint', 'Run linter', 'Lint the codebase.', { dependsOn: ['test'] })
  .step('build', 'Build package', 'Build and verify the package.', { dependsOn: ['lint'] })
  .run();
```

### `topologicalSort()` — Kahn's Algorithm

```typescript
function topologicalSort(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[][] {
  // 1. Build in-degree map + adjacency list
  // 2. Queue all nodes with in-degree 0
  // 3. BFS: process queue, decrement dependents' in-degrees
  // 4. Group by BFS level
  // 5. Detect cycles: if processed < total steps → error
  return levels;
}
```

### `aggregateStatus()`

```typescript
function aggregateStatus(results: WorkflowStepResult[]): 'completed' | 'partial' | 'failed' {
  if (results.length === 0) return 'failed';
  if (results.every(r => r.status === 'completed')) return 'completed';
  if (results.every(r => r.status === 'failed' || r.status === 'skipped')) return 'failed';
  return 'partial';
}
```
