#!/usr/bin/env npx tsx
/**
 * Standard Official Claude Code Runner
 *
 * Calls `claude -p` (non-interactive print mode) for each task.
 * Harness principle: no constraints — max-turns not limited,
 * full output captured, no truncation.
 */
import { execSync } from 'node:child_process';
import type { AgentConfig, BenchmarkTask, RunMetrics } from './types.js';

export async function runOfficialAgent(
  task: BenchmarkTask,
  agent: AgentConfig,
): Promise<{ answer: string; metrics: RunMetrics }> {
  const start = Date.now();

  try {
    const stdout = execSync(
      `claude -p ${JSON.stringify(task.prompt)} --output-format json --dangerously-skip-permissions`,
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
    );

    let answer: string;
    try {
      const parsed = JSON.parse(stdout);
      answer = parsed.result || stdout;
    } catch {
      answer = stdout;
    }

    return {
      answer,
      metrics: {
        durationMs: Date.now() - start,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        iterationCount: 0,
        answerLength: answer.length,
        estimatedCost: 0,
        toolCalls: [],
      },
    };
  } catch (err: any) {
    const msg = err.stdout ?? err.stderr ?? err.message;
    return {
      answer: `[CLAUDE ERROR] ${String(msg).slice(0, 5000)}`,
      metrics: {
        durationMs: Date.now() - start,
        toolCallCount: 0, inputTokens: 0, outputTokens: 0,
        iterationCount: 0, answerLength: 0, estimatedCost: 0, toolCalls: [],
      },
    };
  }
}
