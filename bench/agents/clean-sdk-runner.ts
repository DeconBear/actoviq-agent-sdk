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
const runnerStartedAt = Date.now();
const caseId = process.env.ACTOVIQ_BENCH_CASE_ID;
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const trajectoryFile = process.env.ACTOVIQ_BENCH_TRAJECTORY_FILE;
const internalDir = process.env.ACTOVIQ_BENCH_INTERNAL_DIR ?? path.join(workspace, '.actoviq-bench');
const permissionMode = (process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions') as ActoviqPermissionMode;
const maxToolIterations = Number(
  process.env.ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS ??
  process.env.ACTOVIQ_BENCH_MAX_TURNS ??
  24,
);
const maxRetries = Number(process.env.ACTOVIQ_BENCH_MAX_RETRIES ?? 3);
const timeoutMs = Number(process.env.ACTOVIQ_BENCH_REQUEST_TIMEOUT_MS ?? 300_000);

clearBenchmarkEnv();

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  workDir: workspace,
  sessionDirectory: path.join(internalDir, 'clean-sdk-sessions'),
  tools: createActoviqCoreTools({ cwd: workspace }),
  permissionMode,
  maxToolIterations,
  maxRetries,
  timeoutMs,
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
  const incompleteReason = getIncompleteReason(result);
  const toolCalls = result.toolCalls.map((call) => ({
    ...call,
    isError: call.isError || hasNonZeroExitCode(call),
  }));

  await writeRunnerOutput(outputFile, {
    runtime: 'clean-sdk',
    text: result.text,
    stopReason: result.stopReason,
    incompleteReason,
    metrics: {
      runtime: 'clean-sdk',
      llmRequestCount: result.requests.length,
      requestCount: result.requests.length,
      turnCount: result.requests.length,
      toolCallCount: toolCalls.length,
      toolErrorCount: toolCalls.filter((call) => call.isError).length,
      subagentCallCount: sumDelegatedAgentCounts(result.delegatedAgents),
      skillUseCount: skillNames.length,
      permissionDenialCount: result.permissionDecisions?.filter((decision) => decision.behavior === 'deny').length ?? 0,
      durationMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      cacheReadInputTokens: result.usage?.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: result.usage?.cache_creation_input_tokens ?? undefined,
      toolCalls: toolCalls.map((call) => ({
        name: call.name,
        publicName: call.publicName,
        isError: call.isError,
        durationMs: call.durationMs,
      })),
      subagents: result.delegatedAgents?.map((agent) => ({
        name: agent.name,
        description: agent.lastDescription,
        status: agent.lastStatus,
        runIds: agent.runIds,
        sessionIds: agent.sessionIds,
        taskIds: agent.taskIds,
        toolCallCount: agent.totalToolCallCount,
        toolErrorCount: agent.totalToolErrorCount,
      })),
      skills: skillNames,
    },
  });

  console.log(result.text);
  if (incompleteReason) {
    process.exitCode = 1;
  }
} catch (error) {
  const normalized = normalizeError(error);
  await appendTrajectoryEvent(trajectoryFile, {
    runtime: 'clean-sdk',
    caseId,
    actor: { type: 'main-agent' },
    event: {
      type: 'error',
      name: normalized.name,
      outputSummary: summarizeText(normalized.message),
      isError: true,
      data: {
        stack: normalized.stack,
      },
    },
  });
  await writeRunnerOutput(outputFile, {
    runtime: 'clean-sdk',
    text: '',
    stopReason: null,
    incompleteReason: `agent_error:${normalized.name}`,
    error: {
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
    },
    metrics: {
      runtime: 'clean-sdk',
      llmRequestCount: 0,
      requestCount: 0,
      turnCount: 0,
      toolCallCount: 0,
      toolErrorCount: 1,
      subagentCallCount: 0,
      skillUseCount: 0,
      permissionDenialCount: 0,
      durationMs: Date.now() - runnerStartedAt,
      toolCalls: [],
      subagents: [],
      skills: [],
    },
  });
  console.error(normalized.stack ?? normalized.message);
  process.exitCode = 1;
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

function getIncompleteReason(result: AgentRunResult): string | undefined {
  if (result.incompleteReason) {
    return result.incompleteReason;
  }
  if (result.maxToolIterationsExceeded) {
    return 'max_tool_iterations_exceeded';
  }
  if (result.stopReason === 'tool_use') {
    return 'pending_tool_use';
  }
  return undefined;
}

function hasNonZeroExitCode(call: AgentRunResult['toolCalls'][number]): boolean {
  if (isRecord(call.output) && typeof call.output.exitCode === 'number') {
    return call.output.exitCode !== 0;
  }
  if (typeof call.outputText !== 'string' || call.outputText.trim().length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(call.outputText) as unknown;
    return isRecord(parsed) && typeof parsed.exitCode === 'number' && parsed.exitCode !== 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
    const isError = call.isError || hasNonZeroExitCode(call);
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'tool_call',
        name: call.name,
        inputSummary: summarizeText(JSON.stringify(call.input)),
        outputSummary: summarizeText(call.outputText),
        isError,
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
        isError,
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
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'subagent', name: agent.name },
      event: {
        type: 'subagent_result',
        name: agent.name,
        outputSummary: summarizeText(agent.lastTextSummary),
        data: {
          status: agent.lastStatus,
          lastRunId: agent.lastRunId,
          lastSessionId: agent.lastSessionId,
          lastTaskId: agent.lastTaskId,
          runIds: agent.runIds,
          sessionIds: agent.sessionIds,
          taskIds: agent.taskIds,
          toolCallCount: agent.totalToolCallCount,
          toolErrorCount: agent.totalToolErrorCount,
        },
      },
    });
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
