import path from 'node:path';
import { z } from 'zod';

import {
  createAgentSdk,
  createActoviqFileTools,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
  tool,
  type AgentEvent,
  type AgentToolDefinition,
  type WorkflowDefinition,
  type WorkflowRunResult,
} from 'actoviq-agent-sdk';

// ============================================================
// Agent 自主编排工作流示例
//
// 本示例演示：Agent 接收一个高层级任务后，自主设计多步骤
// 工作流（输出 JSON），通过 run_workflow 工具执行它，最后
// 汇总结果。
//
// 两种自由度在此交汇：
//   1. 人类通过 Builder DSL 编排 → examples/workflow-annotated.ts
//   2. Agent 通过 JSON 编排     → 本文件
// ============================================================

const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'actoviq-skills.settings.local.json',
);

async function loadSettings() {
  try {
    await loadJsonConfigFile(JSON_CONFIG_PATH);
    console.log(`[setup] Loaded config from ${JSON_CONFIG_PATH}`);
  } catch {
    await loadDefaultActoviqSettings();
    console.log('[setup] Loaded default settings from ~/.actoviq/settings.json');
  }
}

// ── 创建 run_workflow 工具 ──────────────────────────────────
//
// 这是 Agent 编排工作流的关键：一个可被 Agent 调用的工具，
// 接收 WorkflowDefinition JSON，调用 sdk.workflow.run() 执行。
//
// Agent 在对话中决定步骤划分、依赖关系、工具权限等，拼出
// JSON 后调用此工具。工具执行完毕后将结果返回给 Agent 做
// 最终汇总。
// ───────────────────────────────────────────────────────────

function createRunWorkflowTool(sdk: Awaited<ReturnType<typeof createAgentSdk>>): AgentToolDefinition {
  return tool(
    {
      name: 'run_workflow',
      description:
        'Execute a multi-step workflow from a JSON definition. '
        + 'Each step runs as an independent session. Steps with dependsOn form a DAG — '
        + 'same-level steps run in parallel. '
        + 'Use this to break complex tasks into ordered, parallel, or dependent steps.\n\n'
        + 'Definition fields:\n'
        + '  name: workflow name\n'
        + '  description: what the workflow does\n'
        + '  steps: array of { id, description, prompt, dependsOn (string[]), '
        + 'allowedTools (string[]), tools (string[]), mode ("react"|"single") }\n\n'
        + 'Available tools for workflow steps: Read, Write, Edit, Glob, Grep, Bash, '
        + 'Task, AskUserQuestion, NotebookEdit (and any custom tools registered with the SDK).\n\n'
        + 'Variable interpolation available in prompts:\n'
        + '  $steps.<id>.text — output text from a previous step\n'
        + '  $steps.<id>.toolCalls — tool names called by a previous step\n'
        + '  $PARAM_NAME — workflow parameter (define via parameters map)\n\n'
        + 'IMPORTANT: Use only tools listed above. Do NOT use tool names that are not available.\n'
        + 'Step IDs should not contain dots (.) — use hyphens or underscores instead.',
      inputSchema: z.object({
        definition: z
          .record(z.string(), z.unknown())
          .describe('The complete WorkflowDefinition object.'),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe('Workflow parameters as key-value pairs.'),
      }),
    },
    async (input, _context) => {
      const definition = input.definition as unknown as WorkflowDefinition;
      const params = (input.params ?? {}) as Record<string, unknown>;

      console.log(`\n[run_workflow] Agent submitted workflow: "${definition.name}"`);
      const steps = definition.steps ?? [];
      console.log(`[run_workflow] ${steps.length} steps:`);
      for (const s of steps) {
        const deps = s.dependsOn?.length ? ` (depends on: ${s.dependsOn.join(', ')})` : '';
        console.log(`  - ${s.id}: "${s.description}"${deps}`);
      }

      const startedAt = Date.now();
      const result: WorkflowRunResult = await sdk.workflow.run(
        definition,
        params,
        {
          onEvent: (event: AgentEvent) => {
            if (event.type === 'step.start') {
              console.log(`  [${event.stepName}] starting...`);
            } else if (event.type === 'step.done') {
              const icon = event.status === 'completed' ? 'OK' : event.status === 'skipped' ? '--' : 'FAIL';
              console.log(`  [${event.stepId}] ${icon} (${event.durationMs}ms)`);
            }
          },
        },
      );

      const elapsed = Date.now() - startedAt;
      console.log(`[run_workflow] Completed in ${elapsed}ms, status: ${result.status}\n`);

      // Format result as readable text for the Agent to consume
      const stepSummaries = result.steps
        .map((s) => {
          const header = `### ${s.id} [${s.status}] (${s.durationMs}ms)`;
          const body = s.text.slice(0, 500) || '(no output)';
          const tools = s.toolCalls.length > 0 ? `\nTools used: ${s.toolCalls.join(', ')}` : '';
          const error = s.error ? `\nError: ${s.error}` : '';
          return `${header}\n${body}${tools}${error}`;
        })
        .join('\n\n');

      return {
        workflowName: result.workflowName,
        status: result.status,
        durationMs: elapsed,
        stepCount: result.steps.length,
        output: result.text.slice(0, 1000),
        details: stepSummaries,
      };
    },
  );
}

// ── 主流程 ──────────────────────────────────────────────────

async function main() {
  await loadSettings();

  const sdk = await createAgentSdk({
    workDir: process.cwd(),
    tools: [
      ...createActoviqFileTools({ cwd: process.cwd() }),
    ],
    maxToolIterations: 16,
  });

  // 注册 run_workflow 工具（闭包捕获 sdk）
  const runWorkflowTool = createRunWorkflowTool(sdk);

  console.log('=== Agent 自主编排工作流示例 ===\n');

  // ── 给 Agent 的任务 ─────────────────────────────────────
  //
  // 这是一个演示：Agent 接收高层级任务，自主设计多步骤
  // WorkflowDefinition JSON，通过 run_workflow 工具执行。
  //
  // 关键约束：任务本身足够简单，Agent 不需要预先探索仓库
  // 就能设计 workflow。真实场景中 Agent 可以先 Read/Glob
  // 了解情况再编排。
  // ─────────────────────────────────────────────────────────

  const taskPrompt = [
    'You are an AI workflow orchestrator. Your job: receive a task, then design and execute a multi-step workflow to complete it.',
    '',
    '## Your Only Tool',
    '- **run_workflow**: execute a workflow from a JSON definition. Call this ONCE with the complete workflow.',
    '',
    '## Workflow Design Rules',
    '- Each step is an independent session with its own prompt.',
    '- Use `dependsOn` to order steps. Independent steps run in parallel.',
    '- Use `allowedTools` to restrict what each step can do (e.g., read-only steps = only Read/Glob/Grep).',
    '- Use `mode: "single"` for steps that just generate text with no tool calls.',
    '- Default `mode` is `"react"` for tool-using steps.',
    '- Reference previous step output with `$steps.<id>.text`.',
    '- Step `description` is the human-readable display name.',
    '- Step `id` should use hyphens for multi-word IDs (e.g., "list-files").',
    '- Available tools for workflow steps: Read, Write, Edit, Glob, Grep.',
    '',
    '## Your Task',
    'Design and execute a workflow with these 3 steps to analyze the current project directory:',
    '',
    '1. **list-files**: Use Glob to find *.ts files and list the top-level structure. `allowedTools: ["Glob", "Read"]`.',
    '2. **read-package**: Read package.json to extract project name, version, and scripts. `allowedTools: ["Read"]`.',
    '3. **report**: Use `$steps.list-files.text` and `$steps.read-package.text` to write a one-paragraph project health summary. `mode: "single"`.',
    '',
    'Step 3 depends on BOTH step 1 AND step 2 (they run in parallel).',
    '',
    'IMPORTANT: Do NOT explore the repo first. Design the workflow JSON now and call run_workflow ONCE.',
  ].join('\n');

  const session = await sdk.createSession({
    title: 'Agent Workflow Orchestration Demo',
    systemPrompt: [
      'You are a workflow orchestration agent. Your only job: design a workflow JSON and call run_workflow.',
      'Do NOT explore the repo. Do NOT run tools yourself. Just design the workflow and call run_workflow ONCE.',
      'Respond in English. Be concise.',
    ].join('\n'),
  });

  console.log('--- Agent is designing the workflow ---\n');

  const result = await session.send(taskPrompt, {
    tools: [runWorkflowTool],
    permissionMode: 'bypassPermissions',
  });

  console.log('\n=== Agent Response ===');
  console.log(result.text);
  console.log(`\nTool calls made: ${result.toolCalls.map((c) => c.name).join(', ') || '(none)'}`);

  await sdk.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
