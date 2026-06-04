import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
} from '../../src/index.js';
import type { ActoviqPermissionMode, AgentRunResult } from '../../src/types.js';
import { appendTrajectoryEvent, summarizeText } from '../trajectory.js';

const workspace = readRequiredEnv('ACTOVIQ_BENCH_WORKSPACE');
const instruction = readRequiredEnv('ACTOVIQ_BENCH_INSTRUCTION');
const caseId = process.env.ACTOVIQ_BENCH_CASE_ID;
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const trajectoryFile = process.env.ACTOVIQ_BENCH_TRAJECTORY_FILE;
const internalDir = process.env.ACTOVIQ_BENCH_INTERNAL_DIR ?? path.join(workspace, '.actoviq-bench');
const permissionMode = (process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions') as ActoviqPermissionMode;
const maxToolIterations = Number(process.env.ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS ?? 24);

clearBenchmarkEnv();

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  workDir: workspace,
  sessionDirectory: path.join(internalDir, 'clean-sdk-sessions'),
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
      benchmarkCaseId: caseId,
      benchmarkRuntime: 'clean-sdk',
    },
  });
  await writeTrajectory(result);
  const skillNames = getSkillNames(result);

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
      skillUseCount: skillNames.length,
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
      skills: skillNames,
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

function getSkillNames(result: AgentRunResult): string[] {
  const invoked = result.invokedSkills?.map((skill) => skill.name) ?? [];
  const toolBased = result.toolCalls
    .filter((call) => call.name.toLowerCase().includes('skill'))
    .map((call) => call.publicName || call.name);
  return [...new Set([...invoked, ...toolBased])];
}

async function writeTrajectory(result: AgentRunResult): Promise<void> {
  for (const request of result.requests) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'llm_request',
        name: request.model,
        outputSummary: request.stopReason ?? undefined,
        data: {
          iteration: request.iteration,
          inputTokens: request.usage?.input_tokens,
          outputTokens: request.usage?.output_tokens,
        },
      },
    });
  }
  for (const call of result.toolCalls) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'tool_call',
        name: call.name,
        inputSummary: summarizeText(JSON.stringify(call.input)),
        outputSummary: summarizeText(call.outputText),
        isError: call.isError,
        durationMs: call.durationMs,
      },
    });
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'tool', name: call.name },
      event: {
        type: 'tool_result',
        name: call.name,
        outputSummary: summarizeText(call.outputText),
        isError: call.isError,
        durationMs: call.durationMs,
      },
    });
  }
  for (const agent of result.delegatedAgents ?? []) {
    for (let i = 0; i < agent.count; i += 1) {
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'subagent_start',
          name: agent.name,
          inputSummary: summarizeText(agent.lastDescription),
        },
      });
    }
  }
  for (const skill of result.invokedSkills ?? []) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'skill_load',
        name: skill.name,
        inputSummary: summarizeText(skill.args),
        data: {
          source: skill.source,
          loadedFrom: skill.loadedFrom,
        },
      },
    });
  }
  if (!result.invokedSkills?.length) {
    for (const skillToolCall of result.toolCalls.filter((call) => call.name.toLowerCase().includes('skill'))) {
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'skill_load',
          name: skillToolCall.publicName || skillToolCall.name,
          inputSummary: summarizeText(JSON.stringify(skillToolCall.input)),
          isError: skillToolCall.isError,
        },
      });
    }
  }
  for (const decision of result.permissionDecisions ?? []) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'harness', name: 'permission' },
      event: {
        type: 'permission_decision',
        name: decision.toolName,
        outputSummary: decision.behavior,
        isError: decision.behavior === 'deny',
        data: {
          publicName: decision.publicName,
          source: decision.source,
          reason: decision.reason,
        },
      },
    });
  }
  await appendTrajectoryEvent(trajectoryFile, {
    runtime: 'clean-sdk',
    caseId,
    actor: { type: 'main-agent' },
    event: {
      type: 'assistant_message',
      outputSummary: summarizeText(result.text),
      data: {
        stopReason: result.stopReason,
      },
    },
  });
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

function clearBenchmarkEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ACTOVIQ_BENCH_')) {
      delete process.env[key];
    }
  }
}
