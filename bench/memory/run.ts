import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Message, MessageParam } from '../../src/provider/types.js';
import {
  completeDurableMemoryConsolidation,
  prepareDurableMemoryConsolidation,
} from '../../src/memory/durableMemoryPipeline.js';
import { createDefaultHadamardSessionMemoryRuntimeState } from '../../src/memory/hadamardSessionMemoryState.js';
import {
  compactHadamardSession,
  resolveHadamardCompactBudget,
} from '../../src/runtime/hadamardCompact.js';
import type {
  HadamardCompactConfig,
  HadamardDreamPaths,
  ModelApi,
  ModelRequest,
  ModelStreamHandle,
  StoredSession,
} from '../../src/types.js';

interface LocalBenchmarkCase {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-memory-bench-'));
try {
  const cases = [
    await benchmarkMillionTokenCompact(),
    await benchmarkDurableMemoryIsolation(root),
  ];
  const report = {
    schemaVersion: 1,
    suite: 'hadamard-memory-local',
    generatedAt: new Date().toISOString(),
    passed: cases.every(item => item.passed),
    cases,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

async function benchmarkMillionTokenCompact(): Promise<LocalBenchmarkCase> {
  const config: HadamardCompactConfig = {
    enabled: true,
    preserveRecentMessages: 8,
    preserveRecentUserTokens: 20_000,
    maxSummaryTokens: 20_000,
    microcompactEnabled: false,
    microcompactKeepRecentToolResults: 3,
    microcompactMinContentChars: 1_000,
    loopAutoCompactEnabled: true,
    contextWindowTokens: 1_000_000,
    effectiveContextWindowPercent: 95,
  };
  const budget = resolveHadamardCompactBudget(config);
  const tailMarker = 'RECENT_USER_CONTINUITY_MARKER';
  const oldPayload = 'old context '.repeat(8_000);
  const messages: MessageParam[] = [
    { role: 'user', content: oldPayload },
    { role: 'assistant', content: [{ type: 'text', text: oldPayload }] },
    { role: 'user', content: oldPayload },
    { role: 'assistant', content: [{ type: 'text', text: 'Older answer.' }] },
    { role: 'user', content: tailMarker },
  ];
  const original = structuredClone(messages);
  const session = storedSession('compact-1m', '/benchmark/project', messages);
  const modelApi: ModelApi = {
    async createMessage(_request: ModelRequest): Promise<Message> {
      return message('Dense continuation summary for the old context.');
    },
    streamMessage(): ModelStreamHandle {
      throw new Error('The local compact benchmark does not stream.');
    },
  };
  const below = await compactHadamardSession(
    session,
    { trigger: 'auto' },
    {
      workDir: '/benchmark/project',
      model: 'benchmark-model',
      modelApi,
      compactConfig: config,
      runtimeState: createDefaultHadamardSessionMemoryRuntimeState(),
      reportedInputTokens: 899_999,
    },
  );
  const atLimit = await compactHadamardSession(
    session,
    { trigger: 'auto' },
    {
      workDir: '/benchmark/project',
      model: 'benchmark-model',
      modelApi,
      compactConfig: config,
      runtimeState: createDefaultHadamardSessionMemoryRuntimeState(),
      reportedInputTokens: 900_000,
    },
  );
  const active = JSON.stringify(atLimit.session.messages);
  const passed = budget.rawContextWindowTokens === 1_000_000
    && budget.effectiveContextWindowTokens === 950_000
    && budget.autoCompactTokenLimit === 900_000
    && below.result.compacted === false
    && atLimit.result.compacted === true
    && active.includes(tailMarker)
    && JSON.stringify(session.messages) === JSON.stringify(original);
  return {
    name: '1m-compact-trigger-and-continuity',
    passed,
    details: {
      budget,
      belowLimitReason: below.result.reason,
      atLimitReason: atLimit.result.reason,
      recentUserMessagePreserved: active.includes(tailMarker),
      originalTranscriptInputUnchanged: JSON.stringify(session.messages) === JSON.stringify(original),
    },
  };
}

async function benchmarkDurableMemoryIsolation(root: string): Promise<LocalBenchmarkCase> {
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const stateA = path.join(root, 'state-a');
  const pathsA = dreamPaths(stateA);
  await Promise.all([
    mkdir(projectA),
    mkdir(projectB),
    mkdir(pathsA.memoryDir, { recursive: true }),
  ]);
  const sessions = [
    storedSession('a-one', projectA),
    storedSession('a-two', projectA),
    storedSession('b-one', projectB),
  ];
  for (const session of sessions) {
    await writeFile(
      path.join(stateA, `${session.id}.jsonl`),
      `${JSON.stringify({ message: { role: 'user', content: `Knowledge from ${session.id}` } })}\n`,
      'utf8',
    );
  }
  const prepared = await prepareDurableMemoryConsolidation({
    paths: pathsA,
    projectPath: projectA,
    sessions,
    currentSessionId: 'current',
    force: true,
    config: {
      minHours: 0,
      minSessions: 1,
      scanIntervalMs: 0,
      minRolloutIdleHours: 12,
      maxRolloutAgeDays: 30,
      maxRolloutsPerStartup: 6,
    },
    maxInputTokens: 20_000,
    extract: async ({ session }) => ({
      rawMemory: `Durable ${session.id}`,
      rolloutSummary: `Summary ${session.id}`,
      rolloutSlug: session.id,
      noOutput: false,
    }),
  });
  if (!prepared) {
    return { name: 'multi-session-durable-memory-project-isolation', passed: false, details: { reason: 'lease unavailable' } };
  }
  const raw = await readFile(pathsA.rawMemoriesPath, 'utf8');
  const passed = prepared.extractedSessionIds.length === 2
    && prepared.extractedSessionIds.every(id => id.startsWith('a-'))
    && raw.includes('Durable a-one')
    && raw.includes('Durable a-two')
    && !raw.includes('b-one');
  await completeDurableMemoryConsolidation({ paths: pathsA, prepared, success: passed });
  return {
    name: 'multi-session-durable-memory-project-isolation',
    passed,
    details: {
      extractedSessionIds: prepared.extractedSessionIds,
      selectedSessionIds: prepared.selectedSessionIds,
      diff: prepared.diff,
      foreignProjectExcluded: !raw.includes('b-one'),
    },
  };
}

function storedSession(id: string, workDir: string, messages: MessageParam[] = []): StoredSession {
  const touched = new Date(Date.now() - 13 * 60 * 60 * 1_000).toISOString();
  return {
    version: 1,
    revision: 0,
    id,
    title: id,
    titleSource: 'manual',
    model: 'benchmark-model',
    tags: [],
    metadata: { __hadamardWorkDir: workDir },
    createdAt: touched,
    updatedAt: touched,
    lastRunAt: touched,
    lastActiveAt: touched,
    status: 'idle',
    messages,
    runs: [],
    kind: 'main',
  };
}

function dreamPaths(projectStateDir: string): HadamardDreamPaths {
  const memoryDir = path.join(projectStateDir, 'memory');
  return {
    memoryDir,
    teamMemoryDir: path.join(memoryDir, 'team'),
    memoryEntrypoint: path.join(memoryDir, 'MEMORY.md'),
    teamMemoryEntrypoint: path.join(memoryDir, 'team', 'MEMORY.md'),
    transcriptDir: projectStateDir,
    lockPath: path.join(memoryDir, '.consolidate-lock'),
    stateDbPath: path.join(projectStateDir, 'memory-state.sqlite'),
    rawMemoriesPath: path.join(memoryDir, 'raw_memories.md'),
    rolloutSummariesDir: path.join(memoryDir, 'rollout_summaries'),
    memorySummaryPath: path.join(memoryDir, 'memory_summary.md'),
  };
}

function message(text: string): Message {
  return {
    id: 'benchmark-summary',
    type: 'message',
    role: 'assistant',
    model: 'benchmark-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1_000,
      output_tokens: 100,
    },
  } as Message;
}
