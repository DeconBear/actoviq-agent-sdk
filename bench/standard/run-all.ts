#!/usr/bin/env npx tsx
/**
 * Standard Benchmark Orchestrator — v0.5.0
 *
 * Loads tasks from bench/cases/standard/*.json, runs all agents,
 * scores with DeepSeek judge, records full metrics.
 *
 * Usage: npx tsx bench/standard/run-all.ts
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import type { BenchmarkTask, AgentConfig, BenchmarkRun, BenchmarkRecord } from './types.js';
import { runHadamardAgent } from './runner-hadamard.js';
import { runBridgeAgent } from './runner-bridge.js';
import { runOfficialAgent } from './runner-official.js';
import { scoreAnswer } from './scoring.js';

// ── Load tasks from JSON ──────────────────────────────────────────

function loadTasks(): BenchmarkTask[] {
  const pattern = path.join(process.cwd(), 'bench/cases/standard/*.json');
  const files = glob.sync(pattern);
  const tasks: BenchmarkTask[] = [];
  for (const file of files.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw.id && raw.prompt) {
        tasks.push({
          id: raw.id,
          title: raw.title ?? raw.id,
          category: raw.category ?? 'analysis',
          prompt: raw.prompt,
          expectedCoverage: raw.expectedCoverage ?? [],
        });
      }
    } catch (e: any) {
      console.warn(`  ⚠ Skipping ${path.basename(file)}: ${e.message}`);
    }
  }
  return tasks;
}

// ── Agent definitions ─────────────────────────────────────────────

const AGENTS: AgentConfig[] = [
  {
    name: 'hadamard',
    label: 'Hadamard SDK',
    model: 'deepseek-v4-pro',
    maxTokens: 384000,
    hasWebSearch: true,
    hasTeamTool: false,
  },
  {
    name: 'hadamard',
    label: 'Hadamard+Team',
    model: 'deepseek-v4-pro',
    maxTokens: 384000,
    hasWebSearch: true,
    hasTeamTool: true,
  },
  {
    name: 'bridge',
    label: 'Bridge SDK',
    model: 'deepseek-v4-pro',
    maxTokens: 384000,
    hasWebSearch: true,
    hasTeamTool: false,
  },
  {
    name: 'official',
    label: 'Official Claude Code',
    model: 'claude-sonnet-4-6',
    maxTokens: 32000,
    hasWebSearch: true,
    hasTeamTool: false,
  },
];

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const TASKS = loadTasks();
  if (TASKS.length === 0) {
    console.error('No tasks found in bench/cases/standard/*.json');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Standard Benchmark Suite — v0.5.0              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`Tasks: ${TASKS.length} · Agents: ${AGENTS.map(a => a.label).join(', ')}\n`);

  const resultsDir = path.join(process.cwd(), 'bench', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const recordPath = path.join(resultsDir, 'benchmark-record.json');
  let record: BenchmarkRecord;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    record.tasks = TASKS;
    record.agents = AGENTS;
  } catch {
    record = { version: '0.5.0', tasks: TASKS, agents: AGENTS, runs: [] };
  }

  const newRuns: BenchmarkRun[] = [];

  for (const task of TASKS) {
    for (const agent of AGENTS) {
      const runId = randomUUID();
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  ${task.title} (${task.id})`);
      console.log(`  Agent: ${agent.label}`);

      try {
        console.log(`  Running...`);
        let answer: string;
        let metrics: any;

        switch (agent.name) {
          case 'hadamard': ({ answer, metrics } = await runHadamardAgent(task, agent)); break;
          case 'bridge':   ({ answer, metrics } = await runBridgeAgent(task, agent)); break;
          case 'official': ({ answer, metrics } = await runOfficialAgent(task, agent)); break;
          default: throw new Error(`Unknown agent: ${agent.name}`);
        }

        console.log(`  ✓ ${(metrics.durationMs / 1000).toFixed(0)}s · ${metrics.toolCallCount} tools · ${metrics.iterationCount} iters · ${metrics.answerLength.toLocaleString()} chars · ${(metrics.inputTokens + metrics.outputTokens).toLocaleString()} tok`);

        console.log(`  Scoring...`);
        const scores = await scoreAnswer(answer, task.prompt, task.expectedCoverage);
        console.log(`  F=${scores.factual} B=${scores.breadth} S=${scores.structure} C=${scores.citation} E=${scores.efficiency} → OVERALL=${scores.overall}/10`);

        const run: BenchmarkRun = {
          runId,
          timestamp: new Date().toISOString(),
          task,
          agent,
          answer,
          metrics,
          scores,
        };
        newRuns.push(run);
        record.runs.push(run);
      } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message?.slice(0, 150)}`);
        newRuns.push({
          runId, timestamp: new Date().toISOString(), task, agent,
          answer: `[ERROR] ${err.message}`,
          metrics: { durationMs: 0, toolCallCount: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, iterationCount: 0, answerLength: 0, estimatedCost: 0 },
          scores: { factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0, overall: 0 },
        });
        record.runs.push(record.runs[record.runs.length - 1]!);
      }
    }
  }

  // Save
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Done! ${newRuns.length} runs → ${recordPath}`);
  console.log(`  Dashboard: bench/dashboard.html`);

  // Quick summary
  const byAgent: Record<string, number[]> = {};
  for (const r of newRuns.filter(r => !r.answer.startsWith('[ERROR]'))) {
    (byAgent[r.agent.label] ??= []).push(r.scores.overall);
  }
  for (const [label, scores] of Object.entries(byAgent)) {
    console.log(`    ${label}: ${scores.map(s => s.toFixed(1)).join(', ')} avg=${(scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
