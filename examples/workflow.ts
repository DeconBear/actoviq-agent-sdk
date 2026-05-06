import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';
import type { AgentEvent } from 'actoviq-agent-sdk';

// ============================================================
// Workflow Orchestration Example
//
// A workflow is a DAG of steps. Each step runs as an
// independent ReAct session. Steps connected via `dependsOn`
// form a DAG — same-level steps run in parallel.
//
// Variable interpolation:
//   $steps.<id>.text — pass text from a previous step
//   $PARAM_NAME       — inject a workflow parameter
// ============================================================

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

// ---- 1. Define and run a simple linear workflow ----
const result1 = await sdk.workflow
  .define('code-review', 'Automated code review pipeline')
  .step('typecheck', 'Type Check', 'Run type checking', 'Run tsc --noEmit on the project.')
  .step(
    'lint',
    'Lint',
    'Run linter',
    'Run ESLint on the project, using the results from typecheck: $steps.typecheck.text',
    { dependsOn: ['typecheck'] },
  )
  .step(
    'report',
    'Report',
    'Generate report',
    'Write a summary report combining typecheck ($steps.typecheck.text) and lint ($steps.lint.text) results.',
    { dependsOn: ['typecheck', 'lint'] },
  )
  .run();

console.log('Workflow status:', result1.status);
console.log('Duration:', result1.durationMs, 'ms');
for (const step of result1.steps) {
  console.log(`  ${step.id}: ${step.status} (${step.durationMs}ms)`);
  if (step.error) console.log(`    error: ${step.error}`);
}

// ---- 2. Workflow with parameters ----
const result2 = await sdk.workflow
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
  .step(
    'verify',
    'Verify',
    'Verify the branch',
    'Based on checkout result ($steps.checkout.text), verify everything is correct.',
    { dependsOn: ['checkout'] },
  )
  .run({ REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' });

console.log('\nParameterized workflow:', result2.status);

// ---- 3. Workflow with tool restrictions ----
const result3 = await sdk.workflow
  .define('safe-read', 'Read-only analysis workflow')
  .step(
    'analyze',
    'Analyze',
    'Read-only analysis',
    'Read and analyze project files to understand the structure.',
    { allowedTools: ['read', 'glob', 'grep'] },
  )
  .run();

console.log('\nRestricted workflow:', result3.status);
for (const step of result3.steps) {
  console.log(`  ${step.id}: ${step.toolCalls.join(', ') || '(no tools used)'}`);
}

// ---- 4. Subscribe to workflow events ----
const result4 = await sdk.workflow.run(
  {
    name: 'event-demo',
    description: 'Workflow with event listener',
    steps: [
      {
        id: 'step1',
        name: 'Step 1',
        description: 'First step',
        prompt: 'Say hello.',
        dependsOn: [],
      },
      {
        id: 'step2',
        name: 'Step 2',
        description: 'Second step',
        prompt: 'Based on: $steps.step1.text — say goodbye.',
        dependsOn: ['step1'],
      },
    ],
  },
  {},
  {
    onEvent: (event: AgentEvent) => {
      if (event.type === 'workflow.start') {
        console.log(`\n[EVENT] Workflow started: ${event.workflowName} (${event.stepCount} steps)`);
      } else if (event.type === 'step.start') {
        console.log(`[EVENT] Step started: ${event.stepName}`);
      } else if (event.type === 'step.done') {
        console.log(`[EVENT] Step done: ${event.stepId} → ${event.status} (${event.durationMs}ms)`);
      } else if (event.type === 'workflow.done') {
        console.log(`[EVENT] Workflow done: ${event.workflowName} → ${event.status} (${event.durationMs}ms)`);
      }
    },
  },
);

console.log('\nEvent-driven workflow completed:', result4.status);
