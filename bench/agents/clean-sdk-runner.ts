import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
} from '../../src/index.js';
import type { ActoviqPermissionMode } from '../../src/types.js';

const workspace = readRequiredEnv('ACTOVIQ_BENCH_WORKSPACE');
const instruction = readRequiredEnv('ACTOVIQ_BENCH_INSTRUCTION');
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const permissionMode = (process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions') as ActoviqPermissionMode;
const maxToolIterations = Number(process.env.ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS ?? 24);

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  workDir: workspace,
  sessionDirectory: path.join(workspace, '.actoviq-bench', 'clean-sdk-sessions'),
  tools: createActoviqCoreTools({ cwd: workspace }),
  permissionMode,
  maxToolIterations,
});

try {
  const result = await sdk.run(buildPrompt(instruction, workspace), {
    permissionMode,
    systemPrompt:
      'You are running inside an isolated benchmark workspace. Complete the user task by changing the workspace as needed. Keep changes focused and do not inspect benchmark internals under .actoviq-bench.',
    metadata: {
      benchmarkCaseId: process.env.ACTOVIQ_BENCH_CASE_ID,
      benchmarkRuntime: 'clean-sdk',
    },
  });

  await writeRunnerOutput(outputFile, {
    runtime: 'clean-sdk',
    text: result.text,
    metrics: {
      runtime: 'clean-sdk',
      llmRequestCount: result.requests.length,
      requestCount: result.requests.length,
      turnCount: result.requests.length,
      toolCallCount: result.toolCalls.length,
      toolErrorCount: result.toolCalls.filter((call) => call.isError).length,
      subagentCallCount: sumDelegatedAgentCounts(result.delegatedAgents),
      skillUseCount: result.invokedSkills?.length ?? 0,
      permissionDenialCount: result.permissionDecisions?.filter((decision) => decision.behavior === 'deny').length ?? 0,
      durationMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      cacheReadInputTokens: result.usage?.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: result.usage?.cache_creation_input_tokens ?? undefined,
      toolCalls: result.toolCalls.map((call) => ({
        name: call.name,
        publicName: call.publicName,
        isError: call.isError,
        durationMs: call.durationMs,
      })),
      subagents: result.delegatedAgents?.map((agent) => ({
        name: agent.name,
        description: agent.lastDescription,
      })),
      skills: result.invokedSkills?.map((skill) => skill.name),
    },
  });

  console.log(result.text);
} finally {
  await sdk.close();
}

function buildPrompt(task: string, cwd: string): string {
  return [
    `Workspace: ${cwd}`,
    '',
    'Task:',
    task.trim(),
  ].join('\n');
}

function sumDelegatedAgentCounts(agents: Array<{ count: number }> | undefined): number {
  return agents?.reduce((sum, agent) => sum + agent.count, 0) ?? 0;
}

async function writeRunnerOutput(filePath: string | undefined, data: unknown): Promise<void> {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
