import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createActoviqBridgeSdk,
  loadDefaultActoviqSettings,
} from '../../src/index.js';
import { analyzeActoviqBridgeEvents } from '../../src/parity/actoviqBridgeEvents.js';
import type { ActoviqBridgePermissionMode } from '../../src/types.js';
import { appendTrajectoryEvent, summarizeText } from '../trajectory.js';

const workspace = readRequiredEnv('ACTOVIQ_BENCH_WORKSPACE');
const instruction = readRequiredEnv('ACTOVIQ_BENCH_INSTRUCTION');
const caseId = process.env.ACTOVIQ_BENCH_CASE_ID;
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const trajectoryFile = process.env.ACTOVIQ_BENCH_TRAJECTORY_FILE;
const permissionMode = (process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions') as ActoviqBridgePermissionMode;
// No declared budget -> unlimited turns, consistent with the Clean SDK runner.
const maxTurnsRaw = process.env.ACTOVIQ_BENCH_MAX_TURNS;
const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : undefined;
const bridgeCliPath = process.env.ACTOVIQ_BENCH_BRIDGE_CLI_PATH;

clearBenchmarkEnv();

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  ...(bridgeCliPath
    ? {
        executable: process.execPath,
        cliPath: path.resolve(bridgeCliPath),
      }
    : {}),
  workDir: workspace,
  permissionMode,
  maxTurns,
});

try {
  const result = await sdk.run(buildPrompt(instruction, workspace), {
    systemPrompt:
      'You are running inside an isolated benchmark workspace. Complete the user task by changing the workspace as needed. Keep changes focused and do not inspect benchmark internals under .actoviq-bench.',
  });
  const eventAnalysis = analyzeActoviqBridgeEvents(result.events);
  const erroredToolIds = new Set(eventAnalysis.toolResults.filter((toolResult) => toolResult.isError).map((toolResult) => toolResult.toolUseId));
  const skillRequests = eventAnalysis.toolRequests.filter((request) => request.name.toLowerCase().includes('skill'));
  await writeTrajectory(result, eventAnalysis);

  await writeRunnerOutput(outputFile, {
    runtime: 'bridge-sdk',
    text: result.text,
    isError: result.isError,
    subtype: result.subtype,
    sessionId: result.sessionId,
    exitCode: result.exitCode,
    stderr: result.stderr,
    metrics: {
      runtime: 'bridge-sdk',
      llmRequestCount: result.numTurns,
      requestCount: result.numTurns,
      turnCount: result.numTurns,
      toolCallCount: eventAnalysis.toolRequests.length,
      toolErrorCount: eventAnalysis.toolResults.filter((toolResult) => toolResult.isError).length,
      subagentCallCount: eventAnalysis.taskInvocations.length,
      agentContinuationCallCount: countAgentContinuations(eventAnalysis.toolRequests),
      backgroundSubagentCallCount: countAgentCalls(eventAnalysis.toolRequests, 'background'),
      isolatedSubagentCallCount: countAgentCalls(eventAnalysis.toolRequests, 'isolated'),
      skillUseCount: skillRequests.length,
      permissionDenialCount: countPermissionDenials(result.events),
      eventCount: result.events.length,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      toolCalls: eventAnalysis.toolRequests.map((request) => ({
        name: request.name,
        isError: request.id ? erroredToolIds.has(request.id) : undefined,
      })),
      subagents: eventAnalysis.taskInvocations.map((task) => ({
        name: task.subagentType,
        description: task.description,
      })),
      skills: [...new Set(skillRequests.map((request) => request.name))],
    },
  });

  console.log(result.text);
  if (result.isError || result.exitCode !== 0) {
    process.exitCode = result.exitCode ?? 1;
  }
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

function isAgentToolName(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

function countAgentContinuations(
  requests: Array<{ name: string; input?: unknown }>,
): number {
  return requests.filter(request => {
    if (request.name === 'SendMessage') {
      return true;
    }
    const input = asRecord(request.input);
    return isAgentToolName(request.name) &&
      typeof input?.resume === 'string' &&
      input.resume.length > 0;
  }).length;
}

function countAgentCalls(
  requests: Array<{ name: string; input?: unknown }>,
  kind: 'background' | 'isolated',
): number {
  return requests.filter(request => {
    if (!isAgentToolName(request.name)) {
      return false;
    }
    const input = asRecord(request.input);
    return kind === 'background'
      ? input?.run_in_background === true
      : input?.isolation === 'worktree';
  }).length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function countPermissionDenials(events: Array<Record<string, unknown>>): number {
  return events.filter((event) => event.type === 'permission_denied').length;
}

async function writeTrajectory(
  result: { text: string; numTurns?: number; assistantMessages: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> },
  eventAnalysis: ReturnType<typeof analyzeActoviqBridgeEvents>,
): Promise<void> {
  const numTurns = result.numTurns ?? result.assistantMessages.length;
  for (let i = 0; i < numTurns; i += 1) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'llm_request',
        name: 'bridge-turn',
        data: { iteration: i + 1 },
      },
    });
  }
  for (const request of eventAnalysis.toolRequests) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'tool_call',
        name: request.name,
        inputSummary: summarizeText(JSON.stringify(request.input)),
        data: {
          provider: request.provider,
          blockType: request.blockType,
        },
      },
    });
  }
  for (const toolResult of eventAnalysis.toolResults) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'tool' },
      event: {
        type: 'tool_result',
        name: toolResult.toolUseId,
        outputSummary: summarizeText(JSON.stringify(toolResult.content)),
        isError: toolResult.isError,
      },
    });
  }
  for (const task of eventAnalysis.taskInvocations) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'subagent_start',
        name: task.subagentType ?? task.name,
        inputSummary: summarizeText(task.description ?? task.prompt),
      },
    });
  }
  for (const request of eventAnalysis.toolRequests.filter((toolRequest) => toolRequest.name.toLowerCase().includes('skill'))) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'skill_load',
        name: request.name,
        inputSummary: summarizeText(JSON.stringify(request.input)),
      },
    });
  }
  for (const event of result.events.filter((item) => item.type === 'permission_denied')) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'bridge-sdk',
      caseId,
      actor: { type: 'harness', name: 'permission' },
      event: {
        type: 'permission_decision',
        outputSummary: summarizeText(JSON.stringify(event)),
        isError: true,
      },
    });
  }
  await appendTrajectoryEvent(trajectoryFile, {
    runtime: 'bridge-sdk',
    caseId,
    actor: { type: 'main-agent' },
    event: {
      type: 'assistant_message',
      outputSummary: summarizeText(result.text),
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
