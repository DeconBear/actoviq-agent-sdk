#!/usr/bin/env npx tsx
/**
 * Standard Benchmark Orchestrator — v0.5.0
 *
 * Loads tasks from bench/cases/standard/*.json, runs all agents,
 * scores with DeepSeek judge, records full metrics.
 *
 * Usage: npx tsx bench/standard/run-all.ts
 */
import './env.js'; // MUST be first: preloads bench keys before runner modules evaluate
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import type { BenchmarkTask, AgentConfig, BenchmarkRun, BenchmarkRecord, StandardScore } from './types.js';
import { runHadamardAgent } from './runner-hadamard.js';
import { runBridgeAgent } from './runner-bridge.js';
import { runOfficialAgent } from './runner-official.js';
import { runAgenticAgent } from './runner-agentic.js';
import { scoreAnswer } from './scoring.js';

// ── Load tasks from JSON ──────────────────────────────────────────

function loadTasks(): BenchmarkTask[] {
  // Relative pattern + cwd so the glob works on Windows (backslashes are escapes
  // in glob patterns). Knowledge tasks live in cases/standard, execution tasks
  // (with a fixture + verify) in cases/agentic.
  const dirs = ['standard', 'agentic'].map((d) => path.join(process.cwd(), 'bench', 'cases', d));
  const files = dirs.flatMap((dir) => glob.sync('*.json', { cwd: dir, absolute: true }));
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
          fixture: raw.fixture,
          verify: raw.verify,
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
    model: 'deepseek-v4-pro',
    maxTokens: 384000,
    hasWebSearch: true,
    hasTeamTool: false,
  },
];

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Optional scope filters (cost control / smoke runs):
  //   BENCH_TASKS="id1,id2"   BENCH_AGENTS="Hadamard SDK,Hadamard+Team"
  const ONLY_TASKS = (process.env.BENCH_TASKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY_AGENTS = (process.env.BENCH_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const TASKS = loadTasks().filter((t) => ONLY_TASKS.length === 0 || ONLY_TASKS.includes(t.id));
  const RUN_AGENTS = ONLY_AGENTS.length === 0 ? AGENTS : AGENTS.filter((a) => ONLY_AGENTS.includes(a.label));
  if (TASKS.length === 0) {
    console.error('No tasks found in bench/cases/standard/*.json');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Standard Benchmark Suite — v0.5.0              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`Tasks: ${TASKS.length} · Agents: ${RUN_AGENTS.map(a => a.label).join(', ')}\n`);

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

  // Flatten task × agent into independent jobs.
  // Repeat each (task, agent) BENCH_TRIALS times for statistical confidence
  // (single runs are high-variance — e.g. citation fabrication swings scores).
  const TRIALS = Math.max(1, Number(process.env.BENCH_TRIALS ?? 1));
  const jobs: Array<{ task: BenchmarkTask; agent: AgentConfig; index: number }> = [];
  for (const task of TASKS) for (const agent of RUN_AGENTS) {
    // Execution-track tasks run only on the in-process Hadamard agents for now
    // (we fully control their workspace + tools); bridge/official agentic is TODO.
    if (task.fixture && agent.name !== 'hadamard') continue;
    for (let t = 0; t < TRIALS; t++) jobs.push({ task, agent, index: jobs.length });
  }
  const total = jobs.length;

  // Bounded concurrency: runs are independent, but provider rate limits cap the
  // useful parallelism. Default 4; set BENCH_CONCURRENCY=1 for strictly sequential.
  const concurrency = Math.max(1, Math.min(total, Number(process.env.BENCH_CONCURRENCY ?? 4)));
  console.log(`Concurrency: ${concurrency} · ${total} runs · ${TRIALS} trial(s)/task\n`);

  // Incremental save after every run so partial results survive a crash and
  // concurrent completions are persisted (writeFileSync is atomic per call).
  const save = () => fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  const runJob = async (job: { task: BenchmarkTask; agent: AgentConfig; index: number }): Promise<void> => {
    const { task, agent } = job;
    const tag = `[${job.index + 1}/${total}] ${agent.label} · ${task.id}`;
    const runId = randomUUID();
    try {
      let answer: string;
      let metrics: any;
      if (task.fixture) {
        ({ answer, metrics } = await runAgenticAgent(task, agent));
      } else {
        switch (agent.name) {
          case 'hadamard': ({ answer, metrics } = await runHadamardAgent(task, agent)); break;
          case 'bridge':   ({ answer, metrics } = await runBridgeAgent(task, agent)); break;
          case 'official': ({ answer, metrics } = await runOfficialAgent(task, agent)); break;
          default: throw new Error(`Unknown agent: ${agent.name}`);
        }
      }
      // Execution tasks are graded objectively by the verifier; knowledge tasks
      // by the LLM judge.
      const scores: StandardScore = task.fixture
        ? {
            factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0,
            overall: metrics.verified ? 10 : 0,
            comment: metrics.verified ? 'verifier passed' : `verifier failed: ${String(metrics.verifyOutput ?? '').slice(0, 200)}`,
          }
        : await scoreAnswer(answer, task.prompt, task.expectedCoverage);
      const run: BenchmarkRun = { runId, timestamp: new Date().toISOString(), task, agent, answer, metrics, scores };
      newRuns.push(run);
      record.runs.push(run);
      save();
      const scoreLabel = task.fixture
        ? (metrics.verified ? 'VERIFIED ✓' : 'VERIFY-FAILED ✗')
        : scores.judgeFailed ? 'JUDGE-FAILED' : `OVERALL=${scores.overall}/10`;
      console.log(`  ✓ ${tag} · ${(metrics.durationMs / 1000).toFixed(0)}s · ${metrics.toolCallCount} tools · ${metrics.answerLength.toLocaleString()} chars · ${scoreLabel}`);
    } catch (err: any) {
      const errorRun: BenchmarkRun = {
        runId, timestamp: new Date().toISOString(), task, agent,
        answer: `[ERROR] ${err.message}`,
        metrics: { durationMs: 0, toolCallCount: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, iterationCount: 0, answerLength: 0, estimatedCost: 0 },
        scores: { factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0, overall: 0 },
      };
      newRuns.push(errorRun);
      record.runs.push(errorRun);
      save();
      console.log(`  ✗ ${tag} · FAILED: ${err.message?.slice(0, 120)}`);
    }
  };

  // Worker pool — at most `concurrency` jobs in flight.
  let nextJob = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = nextJob++;
      if (i >= jobs.length) return;
      await runJob(jobs[i]!);
    }
  });
  await Promise.all(workers);

  save();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Done! ${newRuns.length} runs → ${recordPath}`);
  console.log(`  Dashboard: bench/dashboard.html`);

  // ── Multi-dimensional breakdown ───────────────────────────────────
  // Every axis is reported on its own so each can be examined individually,
  // not collapsed into a single composite. Quality dims come from the judge
  // (knowledge tasks); tools/tokens/latency are objective; ok% is the verifier
  // pass-rate (execution tasks).
  const judgeFails = newRuns.filter(r => r.scores.judgeFailed).length;
  if (judgeFails > 0) console.log(`  ⚠ ${judgeFails} run(s) excluded from quality avgs (judge output unparseable)`);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const cell = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  const agentLabels = [...new Set(newRuns.map(r => r.agent.label))];

  console.log('\n  Per-dimension averages (each dimension scored independently):');
  console.log('  ' + 'agent'.padEnd(22) + ['runs','qual','fact','brth','strc','cite','effi','tools','ktok','sec','ok%'].map(h => h.padStart(6)).join(''));
  for (const label of agentLabels) {
    const runs = newRuns.filter(r => r.agent.label === label && !r.answer.startsWith('[ERROR]'));
    const knowledge = runs.filter(r => !r.task.fixture && !r.scores.judgeFailed);
    const exec = runs.filter(r => r.task.fixture);
    const q = (sel: (s: typeof runs[number]['scores']) => number) => cell(mean(knowledge.map(r => sel(r.scores))));
    const cols = [
      String(runs.length),
      q(s => s.overall), q(s => s.factual), q(s => s.breadth), q(s => s.structure), q(s => s.citation), q(s => s.efficiency),
      cell(mean(runs.map(r => r.metrics.toolCallCount))),
      cell(mean(runs.map(r => (r.metrics.inputTokens + r.metrics.outputTokens) / 1000))),
      cell(mean(runs.map(r => r.metrics.durationMs / 1000)), 0),
      exec.length ? cell(100 * mean(exec.map(r => (r.metrics.verified ? 1 : 0))), 0) : '-',
    ];
    console.log('  ' + label.padEnd(22) + cols.map(c => c.padStart(6)).join(''));
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
