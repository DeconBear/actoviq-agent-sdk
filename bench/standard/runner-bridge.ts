#!/usr/bin/env npx tsx
/**
 * Standard Bridge SDK Agent Runner
 *
 * Uses createActoviqBridgeSdk() which spawns a bun child process
 * running the actoviq-runtime CLI.
 */
import { createActoviqBridgeSdk } from '../../src/index.js';
import type { AgentConfig, BenchmarkTask, RunMetrics } from './types.js';

export async function runBridgeAgent(
  task: BenchmarkTask,
  agent: AgentConfig,
): Promise<{ answer: string; metrics: RunMetrics }> {
  const start = Date.now();

  const sdk = await createActoviqBridgeSdk({
    workDir: process.cwd(),
    permissionMode: 'bypassPermissions',
    model: agent.model,
  });

  const result = await sdk.run(task.prompt);

  // Count tool call events
  const toolCallCount = result.events?.filter((e: any) =>
    e.type === 'assistant' && e.subtype === 'tool_use'
  ).length ?? 0;

  await sdk.close();

  return {
    answer: result.text,
    metrics: {
      durationMs: result.durationMs ?? Date.now() - start,
      toolCallCount,
      inputTokens: 0,
      outputTokens: 0,
      iterationCount: result.numTurns ?? 0,
      answerLength: result.text.length,
      estimatedCost: result.totalCostUsd ?? 0,
      toolCalls: [],
    },
  };
}
