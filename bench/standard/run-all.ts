#!/usr/bin/env npx tsx
/**
 * Standard Benchmark Orchestrator
 *
 * Runs all tasks × all agents, scores with fixed DeepSeek judge,
 * writes benchmark-record.json for the HTML dashboard.
 *
 * Usage: npx tsx bench/standard/run-all.ts
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkTask, AgentConfig, BenchmarkRun, BenchmarkRecord } from './types.js';
import { runHadamardAgent } from './runner-hadamard.js';
import { scoreAnswer } from './scoring.js';

// ═══════════════════════════════════════════════════════════════════
//  Task Definitions
// ═══════════════════════════════════════════════════════════════════

const TASKS: BenchmarkTask[] = [
  {
    id: 'architecture-decision',
    title: 'Architecture Decision Analysis',
    category: 'analysis',
    prompt: [
      'Evaluate three approaches for shared code reuse in a TypeScript monorepo',
      'with 50+ packages, 200+ developers, and 2M+ lines of code:',
      '',
      'A) Single @company/shared package',
      'B) Domain-scoped packages (@company/shared-ui, @company/shared-utils, etc.)',
      'C) Source-level sharing via path aliases with build-time composition',
      '',
      'Analyze each across: build performance, developer experience, versioning,',
      'dead code elimination, CI/CD complexity, and onboarding.',
      'Provide a concrete recommendation with trade-offs.',
    ].join('\n'),
    expectedCoverage: ['build performance', 'developer experience', 'versioning', 'dead code elimination', 'CI/CD', 'onboarding', 'recommendation'],
  },
  {
    id: 'security-review',
    title: 'Security Architecture Review',
    category: 'analysis',
    prompt: [
      'Review this multi-tenant SaaS auth architecture for vulnerabilities:',
      '',
      'JWT auth (24h access + 7d refresh), RBAC with 5 roles, tenant isolation',
      'via tenant_id JWT claim, API gateway JWT validation, mTLS between services,',
      'Postgres RLS, SHA-256 hashed API keys.',
      '',
      'Analyze: token lifecycle, privilege escalation, cross-tenant access,',
      'internal service risks, API key management, supply chain attack surface.',
      'For each vulnerability: severity, attack scenario, recommended fix.',
    ].join('\n'),
    expectedCoverage: ['token lifecycle', 'privilege escalation', 'cross-tenant access', 'internal service', 'API key', 'supply chain', 'severity ratings'],
  },
  {
    id: 'performance-debugging',
    title: 'Complex Performance Debugging',
    category: 'reasoning',
    prompt: [
      'A TypeScript monorepo (Node.js 22, PostgreSQL+pgBouncer, Redis 7, K8s HPA)',
      'experiences intermittent 5-30s response time spikes (~2% of requests).',
      'Spikes correlate with GC pauses and cluster around specific package deployments.',
      'DB/Redis latencies normal. No CPU throttling. Memory stable.',
      '',
      'Formulate 3-5 root cause hypotheses. For each: additional telemetry needed,',
      'investigation priority. Propose quick wins that could mitigate without full root cause.',
    ].join('\n'),
    expectedCoverage: ['hypotheses', 'telemetry', 'investigation steps', 'quick wins', 'Node.js event loop', 'monorepo specifics'],
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Agent Definitions
// ═══════════════════════════════════════════════════════════════════

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
];

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Standard Benchmark Suite — v0.5.0              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`Tasks: ${TASKS.length} · Agents: ${AGENTS.map(a => a.label).join(', ')}\n`);

  const resultsDir = path.join(process.cwd(), 'bench', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  // Load existing record or create new
  const recordPath = path.join(resultsDir, 'benchmark-record.json');
  let record: BenchmarkRecord;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    record.tasks = TASKS; // Update task definitions
    record.agents = AGENTS;
  } catch {
    record = { version: '0.5.0', tasks: TASKS, agents: AGENTS, runs: [] };
  }

  const newRuns: BenchmarkRun[] = [];

  for (const task of TASKS) {
    for (const agent of AGENTS) {
      const runId = randomUUID();
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  Task: ${task.title} (${task.id})`);
      console.log(`  Agent: ${agent.label}`);

      try {
        // Run agent
        console.log(`  Running agent...`);
        const { answer, metrics } = await runHadamardAgent(task, agent);
        console.log(`  ✓ ${(metrics.durationMs / 1000).toFixed(0)}s · ${metrics.toolCallCount} tools · ${metrics.iterationCount} iterations · ${metrics.answerLength.toLocaleString()} chars`);

        // Score with DeepSeek judge
        console.log(`  Scoring with DeepSeek judge...`);
        const scores = await scoreAnswer(answer, task.prompt);
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
          runId,
          timestamp: new Date().toISOString(),
          task,
          agent,
          answer: `[ERROR] ${err.message}`,
          metrics: { durationMs: 0, toolCallCount: 0, inputTokens: 0, outputTokens: 0, iterationCount: 0, answerLength: 0, estimatedCost: 0 },
          scores: { factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0, overall: 0 },
        });
      }
    }
  }

  // Save record
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Done! ${newRuns.length} runs saved to ${recordPath}`);
  console.log(`  Open bench/dashboard.html to view results.`);

  // Quick summary
  const byAgent: Record<string, number[]> = {};
  for (const r of newRuns) {
    const key = r.agent.label;
    if (!byAgent[key]) byAgent[key] = [];
    byAgent[key].push(r.scores.overall);
  }
  console.log('\n  Quick Summary:');
  for (const [label, scores] of Object.entries(byAgent)) {
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    console.log(`    ${label}: avg ${avg}/10 (${scores.join(', ')})`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
