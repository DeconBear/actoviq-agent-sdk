import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendTrajectoryEvent, summarizeText } from '../trajectory.js';

const workspace = readRequiredEnv('ACTOVIQ_BENCH_WORKSPACE');
const instruction = readRequiredEnv('ACTOVIQ_BENCH_INSTRUCTION');
const outputFile = process.env.ACTOVIQ_BENCH_OUTPUT_FILE;
const trajectoryFile = process.env.ACTOVIQ_BENCH_TRAJECTORY_FILE;
const permissionMode = process.env.ACTOVIQ_BENCH_PERMISSION_MODE ?? 'bypassPermissions';
const maxTurns = Number(process.env.ACTOVIQ_BENCH_MAX_TURNS ?? 12);

const messages: SDKMessage[] = [];
for await (const message of query({
  prompt: buildPrompt(instruction, workspace),
  options: {
    cwd: workspace,
    maxTurns,
    permissionMode: permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk',
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    tools: { type: 'preset', preset: 'claude_code' },
    skills: 'all',
    agents: {
      'benchmark-generalist': {
        description: 'Use for benchmark tasks that benefit from independent exploration, verification, or focused test triage.',
        prompt:
          'You are a focused coding subagent in an isolated benchmark workspace. Inspect only what is needed, make no broad refactors, and report concrete findings or changes.',
        maxTurns: 6,
      },
    },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'You are running inside an isolated benchmark workspace. Complete the user task by changing the workspace as needed. Keep changes focused and do not inspect benchmark internals under .actoviq-bench.',
    },
  },
})) {
  messages.push(message);
}

const resultMessage = [...messages].reverse().find((message) => message.type === 'result');
const toolCalls = extractToolCalls(messages);
const toolResults = extractToolResults(messages);
const erroredToolIds = new Set(toolResults.filter((toolResult) => toolResult.isError).map((toolResult) => toolResult.toolUseId));
const subagents = extractSubagents(messages);
const skillRequests = toolCalls.filter((toolCall) => toolCall.name.toLowerCase().includes('skill'));
const resultRecord = isRecord(resultMessage) ? resultMessage : undefined;
const usage = isRecord(resultRecord?.usage) ? resultRecord.usage : undefined;
const outputText = getString(resultRecord, 'result') ?? extractLastAssistantText(messages) ?? '';
await writeTrajectory(messages, toolCalls, toolResults, subagents, skillRequests, resultRecord);

await writeRunnerOutput(outputFile, {
  runtime: 'official-claude-sdk',
  text: outputText,
  isError: resultRecord?.is_error === true,
  subtype: getString(resultRecord, 'subtype'),
  sessionId: getString(resultRecord, 'session_id'),
  metrics: {
    runtime: 'official-claude-sdk',
    llmRequestCount: getNumber(resultRecord, 'num_turns') ?? messages.filter((message) => message.type === 'assistant').length,
    requestCount: getNumber(resultRecord, 'num_turns'),
    turnCount: getNumber(resultRecord, 'num_turns'),
    toolCallCount: toolCalls.length,
    toolErrorCount: toolResults.filter((toolResult) => toolResult.isError).length,
    subagentCallCount: subagents.length,
    skillUseCount: skillRequests.length,
    permissionDenialCount: Array.isArray(resultRecord?.permission_denials) ? resultRecord.permission_denials.length : undefined,
    eventCount: messages.length,
    durationMs: getNumber(resultRecord, 'duration_ms'),
    totalCostUsd: getNumber(resultRecord, 'total_cost_usd'),
    inputTokens: getNumber(usage, 'input_tokens'),
    outputTokens: getNumber(usage, 'output_tokens'),
    cacheReadInputTokens: getNumber(usage, 'cache_read_input_tokens'),
    cacheCreationInputTokens: getNumber(usage, 'cache_creation_input_tokens'),
    toolCalls: toolCalls.map((toolCall) => ({
      name: toolCall.name,
      isError: toolCall.id ? erroredToolIds.has(toolCall.id) : undefined,
      parentToolUseId: toolCall.parentToolUseId,
    })),
    subagents,
    skills: [...new Set(skillRequests.map((toolCall) => toolCall.name))],
  },
});

console.log(outputText);
if (resultRecord?.is_error === true) {
  process.exitCode = 1;
}

function buildPrompt(task: string, cwd: string): string {
  return [
    `Workspace: ${cwd}`,
    '',
    'Task:',
    task.trim(),
  ].join('\n');
}

interface ToolCallSummary {
  id?: string;
  name: string;
  parentToolUseId?: string | null;
}

interface ToolResultSummary {
  toolUseId: string;
  isError: boolean;
}

function extractToolCalls(messagesToInspect: SDKMessage[]): ToolCallSummary[] {
  return messagesToInspect.flatMap((message) => {
    if (message.type !== 'assistant' || !isRecord(message.message) || !Array.isArray(message.message.content)) {
      return [];
    }
    return message.message.content.flatMap((block) => {
      if (!isRecord(block) || typeof block.type !== 'string') {
        return [];
      }
      if (!['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block.type)) {
        return [];
      }
      const name = getString(block, 'name') ?? 'unknown-tool';
      return [{
        id: getString(block, 'id'),
        name,
        parentToolUseId: message.parent_tool_use_id,
      }];
    });
  });
}

function extractToolResults(messagesToInspect: SDKMessage[]): ToolResultSummary[] {
  return messagesToInspect.flatMap((message) => {
    if (message.type !== 'user' || !isRecord(message.message) || !Array.isArray(message.message.content)) {
      return [];
    }
    return message.message.content.flatMap((block) => {
      if (!isRecord(block) || typeof block.type !== 'string' || !block.type.endsWith('tool_result')) {
        return [];
      }
      return [{
        toolUseId: getString(block, 'tool_use_id') ?? 'unknown-tool-call',
        isError: block.is_error === true,
      }];
    });
  });
}

function extractSubagents(messagesToInspect: SDKMessage[]): Array<{ name?: string; description?: string; taskType?: string }> {
  const subagents: Array<{ name?: string; description?: string; taskType?: string }> = [];
  for (const message of messagesToInspect) {
    if (message.type === 'system' && message.subtype === 'task_started') {
      subagents.push({
        name: message.subagent_type,
        description: message.description,
        taskType: message.task_type,
      });
      continue;
    }
    if (message.type === 'assistant' && message.subagent_type) {
      subagents.push({
        name: message.subagent_type,
        description: message.task_description,
      });
    }
  }
  return subagents;
}

function extractLastAssistantText(messagesToInspect: SDKMessage[]): string | undefined {
  for (const message of [...messagesToInspect].reverse()) {
    if (message.type !== 'assistant' || !isRecord(message.message) || !Array.isArray(message.message.content)) {
      continue;
    }
    const text = message.message.content.flatMap((block) => {
      if (!isRecord(block) || block.type !== 'text') {
        return [];
      }
      return typeof block.text === 'string' ? [block.text] : [];
    }).join('\n');
    if (text) {
      return text;
    }
  }
  return undefined;
}

async function writeTrajectory(
  messagesToInspect: SDKMessage[],
  toolCallsToWrite: ToolCallSummary[],
  toolResultsToWrite: ToolResultSummary[],
  subagentsToWrite: Array<{ name?: string; description?: string; taskType?: string }>,
  skillRequestsToWrite: ToolCallSummary[],
  resultToWrite: Record<string, unknown> | undefined,
): Promise<void> {
  const caseId = process.env.ACTOVIQ_BENCH_CASE_ID;
  const resultUsage = isRecord(resultToWrite?.usage) ? resultToWrite.usage : undefined;
  const numTurns = getNumber(resultToWrite, 'num_turns') ?? messagesToInspect.filter((message) => message.type === 'assistant').length;
  for (let i = 0; i < numTurns; i += 1) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'llm_request',
        name: 'official-turn',
        data: {
          iteration: i + 1,
          inputTokens: getNumber(resultUsage, 'input_tokens'),
          outputTokens: getNumber(resultUsage, 'output_tokens'),
        },
      },
    });
  }
  for (const message of messagesToInspect.filter((item) => item.type === 'assistant')) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: {
        type: message.subagent_type ? 'subagent' : 'main-agent',
        name: message.subagent_type,
        parentToolUseId: message.parent_tool_use_id,
      },
      event: {
        type: 'assistant_message',
        outputSummary: summarizeText(extractAssistantText(message)),
      },
    });
  }
  for (const toolCall of toolCallsToWrite) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: { type: 'main-agent', parentToolUseId: toolCall.parentToolUseId },
      event: {
        type: 'tool_call',
        name: toolCall.name,
      },
    });
  }
  for (const toolResult of toolResultsToWrite) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: { type: 'tool' },
      event: {
        type: 'tool_result',
        name: toolResult.toolUseId,
        isError: toolResult.isError,
      },
    });
  }
  for (const subagent of subagentsToWrite) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'subagent_start',
        name: subagent.name,
        inputSummary: summarizeText(subagent.description),
        data: {
          taskType: subagent.taskType,
        },
      },
    });
  }
  for (const skillRequest of skillRequestsToWrite) {
    await appendTrajectoryEvent(trajectoryFile, {
      runtime: 'official-claude-sdk',
      caseId,
      actor: { type: 'main-agent' },
      event: {
        type: 'skill_load',
        name: skillRequest.name,
      },
    });
  }
  if (Array.isArray(resultToWrite?.permission_denials)) {
    for (const denial of resultToWrite.permission_denials) {
      await appendTrajectoryEvent(trajectoryFile, {
        runtime: 'official-claude-sdk',
        caseId,
        actor: { type: 'harness', name: 'permission' },
        event: {
          type: 'permission_decision',
          outputSummary: summarizeText(JSON.stringify(denial)),
          isError: true,
        },
      });
    }
  }
}

function extractAssistantText(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant' || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return undefined;
  }
  return message.message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text') {
      return [];
    }
    return typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
