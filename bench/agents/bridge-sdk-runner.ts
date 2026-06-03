import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createActoviqBridgeSdk,
  loadDefaultActoviqSettings,
} from '../../src/index.js';
import { analyzeActoviqBridgeEvents } from '../../src/parity/actoviqBridgeEvents.js';
import type { ActoviqBridgePermissionMode } from '../../src/types.js';

const workspace = readRequiredEnv('ACTOVIQ_BENCH_WORKSPACE');
const instruction = readRequiredEnv('ACTOVIQ_BENCH_INSTRUCTION');
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const permissionMode = (process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions') as ActoviqBridgePermissionMode;
const maxTurns = Number(process.env.ACTOVIQ_BENCH_MAX_TURNS ?? 12);

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  ...(process.env.ACTOVIQ_BENCH_BRIDGE_CLI_PATH
    ? {
        executable: process.execPath,
        cliPath: path.resolve(process.env.ACTOVIQ_BENCH_BRIDGE_CLI_PATH),
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

function countPermissionDenials(events: Array<Record<string, unknown>>): number {
  return events.filter((event) => event.type === 'permission_denied').length;
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
