import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
} from '../../src/index.js';
import type { ActoviqPermissionMode, AgentEvent, AgentRunResult } from '../../src/types.js';
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

const runnerState = createRunnerState();

try {
  const stream = sdk.stream(buildPrompt(instruction, workspace), {
    permissionMode,
    systemPrompt:
      'You are running inside an isolated benchmark workspace. Complete the user task by changing the workspace as needed. Keep changes focused and do not inspect benchmark internals under .actoviq-bench.',
    metadata: {
      benchmarkCaseId: caseId,
      benchmarkRuntime: 'clean-sdk',
    },
  });
  for await (const event of stream) {
    await recordAgentEvent(event, runnerState);
  }
  const result = runnerState.result ?? await stream.result;
  const skillNames = getSkillNames(result);
  for (const record of result.invokedSkills ?? []) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'clean-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'skill_load',
        name: record.name,
        data: {
          context: record.context,
          source: record.source,
        },
      },
    });
  }
  const incompleteReason = getIncompleteReason(result);
  const toolCalls = result.toolCalls.map((call) => ({
    ...call,
    isError: call.isError || hasNonZeroExitCode(call),
  }));

  await writeRunnerOutput(outputFile, buildRunnerOutput({
    result,
    state: runnerState,
    skillNames,
    toolCalls,
    incompleteReason,
  }));

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
    metrics: buildPartialMetrics(runnerState, normalized),
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

interface RunnerState {
  llmRequestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  permissionDenialCount: number;
  eventCount: number;
  toolCalls: Array<{
    name: string;
    publicName?: string;
    isError?: boolean;
    durationMs?: number;
  }>;
  result?: AgentRunResult;
}

function createRunnerState(): RunnerState {
  return {
    llmRequestCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    permissionDenialCount: 0,
    eventCount: 0,
    toolCalls: [],
  };
}

async function recordAgentEvent(event: AgentEvent, state: RunnerState): Promise<void> {
  state.eventCount += 1;
  switch (event.type) {
    case 'request.started':
      state.llmRequestCount += 1;
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'llm_request',
          name: `iteration-${event.iteration}`,
          data: {
            iteration: event.iteration,
            requestTokenEstimate: event.requestTokenEstimate,
            requestByteLength: event.requestByteLength,
            localMicrocompact: event.localMicrocompact,
          },
        },
      });
      return;
    case 'response.message':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'assistant_message',
          outputSummary: summarizeText(JSON.stringify(event.message.content)),
          data: {
            iteration: event.iteration,
            stopReason: event.message.stop_reason,
            inputTokens: event.message.usage?.input_tokens,
            outputTokens: event.message.usage?.output_tokens,
          },
        },
      });
      return;
    case 'tool.call':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'tool_call',
          name: event.call.name,
          inputSummary: summarizeText(JSON.stringify(event.call.input)),
          data: {
            publicName: event.call.publicName,
            iteration: event.iteration,
          },
        },
      });
      if (event.call.publicName === 'Task') {
        await appendTrajectoryEvent(trajectoryFile, {
          runtime: 'clean-sdk',
          caseId,
          actor: { type: 'main-agent' },
          event: {
            type: 'subagent_start',
            name: readStringField(event.call.input, 'subagent_type') ?? 'unknown',
            inputSummary: summarizeText(
              readStringField(event.call.input, 'description') ??
              readStringField(event.call.input, 'prompt'),
            ),
            data: {
              toolUseId: event.call.id,
              iteration: event.iteration,
            },
          },
        });
      }
      return;
    case 'tool.result': {
      const isError = event.result.isError || hasNonZeroExitCode(event.result);
      state.toolCallCount += 1;
      if (isError) {
        state.toolErrorCount += 1;
      }
      state.toolCalls.push({
        name: event.result.name,
        publicName: event.result.publicName,
        isError,
        durationMs: event.result.durationMs,
      });
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'tool', name: event.result.name },
        event: {
          type: 'tool_result',
          name: event.result.name,
          outputSummary: summarizeText(event.result.outputText),
          isError,
          durationMs: event.result.durationMs,
          data: {
            publicName: event.result.publicName,
            iteration: event.iteration,
          },
        },
      });
      if (event.result.publicName === 'Task') {
        await appendTrajectoryEvent(trajectoryFile, {
          runtime: 'clean-sdk',
          caseId,
          actor: { type: 'subagent', name: readStringField(event.result.input, 'subagent_type') },
          event: {
            type: 'subagent_result',
            name: readStringField(event.result.input, 'subagent_type') ?? 'unknown',
            outputSummary: summarizeText(event.result.outputText),
            isError,
            durationMs: event.result.durationMs,
            data: {
              toolUseId: event.result.id,
              iteration: event.iteration,
            },
          },
        });
      }
      if (event.result.publicName === 'Skill' && !isError) {
        await appendTrajectoryEvent(trajectoryFile, {
          runtime: 'clean-sdk',
          caseId,
          actor: { type: 'main-agent' },
          event: {
            type: 'skill_load',
            name: readStringField(event.result.input, 'skill') ?? 'unknown',
            data: {
              toolUseId: event.result.id,
              iteration: event.iteration,
            },
          },
        });
      }
      return;
    }
    case 'tool.permission':
      if (event.decision.behavior === 'deny') {
        state.permissionDenialCount += 1;
      }
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'harness', name: 'permission' },
        event: {
          type: 'permission_decision',
          name: event.decision.toolName,
          outputSummary: event.decision.behavior,
          isError: event.decision.behavior === 'deny',
          data: {
            publicName: event.decision.publicName,
            source: event.decision.source,
            reason: event.decision.reason,
            iteration: event.iteration,
          },
        },
      });
      return;
    case 'session.compacted':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'compact',
          name: event.trigger,
          outputSummary: event.result.reason,
          data: {
            compacted: event.result.compacted,
            tokenEstimateBefore: event.result.tokenEstimateBefore,
            tokenEstimateAfter: event.result.tokenEstimateAfter,
          },
        },
      });
      return;
    case 'conversation.compacted':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'compact',
          name: 'loop-auto',
          data: {
            iteration: event.iteration,
            tokenEstimateBefore: event.tokenEstimateBefore,
            tokenEstimateAfter: event.tokenEstimateAfter,
            messagesSummarized: event.messagesSummarized,
            preservedMessages: event.preservedMessages,
            clearedToolResults: event.clearedToolResults,
          },
        },
      });
      return;
    case 'model.fallback':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'llm_request',
          name: 'model-fallback',
          outputSummary: summarizeText(event.reason),
          data: {
            iteration: event.iteration,
            fromModel: event.fromModel,
            toModel: event.toModel,
          },
        },
      });
      return;
    case 'response.completed':
      state.result = event.result;
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'assistant_message',
          outputSummary: summarizeText(event.result.text),
          data: {
            stopReason: event.result.stopReason,
            completed: true,
          },
        },
      });
      return;
    case 'error':
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'clean-sdk',
        caseId,
        actor: { type: 'main-agent' },
        event: {
          type: 'error',
          outputSummary: summarizeText(event.error.message),
          isError: true,
          data: {
            code: event.error.code,
            stack: event.error.stack,
          },
        },
      });
      return;
    default:
      return;
  }
}

function buildRunnerOutput(params: {
  result: AgentRunResult;
  state: RunnerState;
  skillNames: string[];
  toolCalls: Array<AgentRunResult['toolCalls'][number]>;
  incompleteReason?: string;
}): unknown {
  const { result, state, skillNames, toolCalls, incompleteReason } = params;
  return {
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
      eventCount: state.eventCount,
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
  };
}

function buildPartialMetrics(state: RunnerState, error: Error): unknown {
  return {
    runtime: 'clean-sdk',
    llmRequestCount: state.llmRequestCount,
    requestCount: state.llmRequestCount,
    turnCount: state.llmRequestCount,
    toolCallCount: state.toolCallCount,
    toolErrorCount: state.toolErrorCount + 1,
    subagentCallCount: 0,
    skillUseCount: 0,
    permissionDenialCount: state.permissionDenialCount,
    eventCount: state.eventCount,
    durationMs: Date.now() - runnerStartedAt,
    toolCalls: state.toolCalls,
    subagents: [],
    skills: [],
    error: {
      name: error.name,
      message: error.message,
    },
  };
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

function readStringField(input: unknown, field: string): string | undefined {
  if (isRecord(input) && typeof input[field] === 'string') {
    return input[field];
  }
  return undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
