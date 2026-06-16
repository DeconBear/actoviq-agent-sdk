#!/usr/bin/env npx tsx
/**
 * Standard Hadamard SDK Agent Runner
 *
 * Harness principle: tools only, no constraints.
 * - Unlimited iterations (Infinity)
 * - No tool output truncation
 * - Model output = max per official docs
 * - Agent autonomously decides when to converge
 */
import { createAgentSdk, loadDefaultActoviqSettings, createTavilySearchTool, createTeamTool } from '../../src/index.js';
import type { TeamDefinition } from '../../src/types.js';
import type { AgentConfig, BenchmarkTask, RunMetrics, ToolCallRecord } from './types.js';

const MINIMAX_KEY = process.env.MINIMAX_API_KEY || '';

const TEAM_DEF: TeamDefinition = {
  name: 'expert-panel', mode: 'panel',
  members: [
    { model: 'MiniMax-M3', provider: 'anthropic', baseURL: 'https://api.minimaxi.com/anthropic/v1', apiKey: MINIMAX_KEY, maxTokens: 131072,
      systemPrompt: 'Rigorous analyst. Verify claims. Identify blind spots. Challenge assumptions.' },
    { model: 'deepseek-v4-pro', provider: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic/v1', maxTokens: 384000,
      systemPrompt: 'Expert researcher. Deep thinking. Comprehensive analysis.' },
  ],
  primary: { model: 'deepseek-v4-pro', systemPrompt: 'Synthesize panel. Flag agreements/contradictions. Fill gaps.' },
  timeoutMs: 300000,
};

export async function runHadamardAgent(
  task: BenchmarkTask,
  agent: AgentConfig,
): Promise<{ answer: string; metrics: RunMetrics }> {
  await loadDefaultActoviqSettings().catch(() => {});

  // Tools: TavilySearch always, Team tool if configured
  const tools = [createTavilySearchTool()];
  if (agent.hasTeamTool) tools.push(createTeamTool(TEAM_DEF));

  const sdk = await createAgentSdk({
    workDir: process.cwd(),
    tools,
    permissionMode: 'bypassPermissions',
    // No maxToolIterations → Infinity. Harness principle.
  });

  const prompt = [
    'Research and answer the question comprehensively.',
    'Use TavilySearch (depth="advanced", max_results=5) to find authoritative sources.',
    'Be efficient with searches — quality over quantity.',
    '',
    'Your answer MUST:',
    '- Cover all key aspects of the question thoroughly',
    '- Include specific data, numbers, and concrete examples',
    '- Use tables and structured formatting where helpful',
    '- Include a "Sources:" section with markdown hyperlinks',
    '- Be COMPLETE — do not cut off mid-sentence',
    '',
    agent.hasTeamTool
      ? 'After research, call `expert-panel` with {"prompt":"<the question>"} for multi-model verification before finalizing.'
      : '',
    '',
    `QUESTION:\n${task.prompt}`,
  ].join('\n');

  const start = Date.now();
  const session = await sdk.createSession({ title: `bench-${task.id}` });
  const result = await session.send(prompt, { permissionMode: 'bypassPermissions' });

  const totalIn = result.requests.reduce((s: number, r: any) => s + (r.usage?.input_tokens ?? 0), 0);
  const totalOut = result.requests.reduce((s: number, r: any) => s + (r.usage?.output_tokens ?? 0), 0);

  await sdk.close();

  // Build tool trajectory
  const toolCalls: ToolCallRecord[] = result.toolCalls.map((tc: any) => ({
    name: tc.name,
    durationMs: tc.durationMs ?? 0,
    isError: tc.isError ?? false,
    inputSummary: typeof tc.input === 'string' ? tc.input.slice(0, 100) : JSON.stringify(tc.input ?? {}).slice(0, 100),
  }));

  return {
    answer: result.text,
    metrics: {
      durationMs: Date.now() - start,
      toolCallCount: result.toolCalls.length,
      toolCalls,
      inputTokens: totalIn,
      outputTokens: totalOut,
      iterationCount: result.requests.length,
      answerLength: result.text.length,
      estimatedCost: 0,
    },
  };
}
