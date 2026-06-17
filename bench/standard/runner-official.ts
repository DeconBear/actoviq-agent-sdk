#!/usr/bin/env npx tsx
/**
 * Standard Official Claude Code Runner
 *
 * Calls `claude -p` (non-interactive print mode) for each task.
 * Harness principle: no constraints — max-turns not limited,
 * full output captured, no truncation.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentConfig, BenchmarkTask, RunMetrics } from './types.js';
import { buildBenchmarkPrompt } from './prompt.js';

// Async exec (shell-based, so the Windows `claude` shim resolves) — unlike
// execSync it does not block the event loop, which is required for parallel runs.
const execAsync = promisify(exec);

export async function runOfficialAgent(
  task: BenchmarkTask,
  agent: AgentConfig,
): Promise<{ answer: string; metrics: RunMetrics }> {
  const start = Date.now();
  const prompt = buildBenchmarkPrompt(task, { hasTeamTool: false });

  try {
    const { stdout } = await execAsync(
      `claude -p ${JSON.stringify(prompt)} --model ${agent.model} --output-format json --dangerously-skip-permissions`,
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
    );

    let answer = stdout;
    let inputTokens = 0;
    let outputTokens = 0;
    let iterationCount = 0;
    let estimatedCost = 0;
    try {
      const parsed = JSON.parse(stdout);
      answer = parsed.result ?? stdout;
      inputTokens = parsed.usage?.input_tokens ?? 0;
      outputTokens = parsed.usage?.output_tokens ?? 0;
      iterationCount = parsed.num_turns ?? 0;
      estimatedCost = parsed.total_cost_usd ?? 0;
    } catch {
      answer = stdout;
    }

    return {
      answer,
      metrics: {
        durationMs: Date.now() - start,
        toolCallCount: 0,
        inputTokens,
        outputTokens,
        iterationCount,
        answerLength: answer.length,
        estimatedCost,
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
