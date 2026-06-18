#!/usr/bin/env npx tsx
import './env.js'; // MUST be first: preloads bench keys before runner modules evaluate
/**
 * Reviewer-track benchmark — measures how well the `reviewer` team mode finds
 * planted, verifiable bugs without inventing false positives.
 *
 *   npx tsx bench/standard/run-review.ts
 *
 * Env options:
 *   REVIEW_AGENTS="deepseek-v4-pro,MiniMax-M3"   models to compare (default deepseek-v4-pro)
 *   REVIEW_FIXTURES="csv-bugs,discount-bugs"     fixtures to run (default: all)
 *   REVIEW_TRIALS=3                              repeat each (agent×fixture) N times (default 1)
 */
import path from 'node:path';
import { glob } from 'glob';

import { runReviewer } from './runner-reviewer.js';
import { scoreReview } from './scoring-review.js';
import type { ReviewAgent, ReviewScore } from './review-types.js';

interface Row {
  agent: string;
  fixture: string;
  trial: number;
  bugs: number;
  recall: number;
  precision: number;
  falsePositives: number;
  durationMs: number;
  judgeFailed?: boolean;
  comment?: string;
}

function avg(ns: number[]): number {
  if (ns.length === 0) return 0;
  return Math.round((ns.reduce((s, n) => s + n, 0) / ns.length) * 100) / 100;
}

async function main(): Promise<void> {
  const reviewDir = path.join(process.cwd(), 'bench', 'fixtures', 'review');
  // Relative pattern + cwd so the glob works on Windows (backslashes are escapes).
  const allFixtures = glob.sync('*/review-manifest.json', { cwd: reviewDir }).map((p) => path.dirname(p));
  const only = (process.env.REVIEW_FIXTURES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fixtures = only.length ? allFixtures.filter((f) => only.includes(f)) : allFixtures;

  const agents: ReviewAgent[] = (process.env.REVIEW_AGENTS ?? 'deepseek-v4-pro')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((model) => ({ name: model, label: model, model }));

  const trials = Math.max(1, Number(process.env.REVIEW_TRIALS) || 1);

  if (fixtures.length === 0) {
    console.error('No review fixtures found under bench/fixtures/review/.');
    process.exit(1);
  }

  console.log(`Reviewer bench — ${agents.length} agent(s) × ${fixtures.length} fixture(s) × ${trials} trial(s)\n`);

  const rows: Row[] = [];
  for (const agent of agents) {
    for (const fixture of fixtures) {
      for (let t = 1; t <= trials; t++) {
        process.stdout.write(`· ${agent.label} / ${fixture} #${t} … `);
        try {
          const run = await runReviewer(fixture, agent);
          const score: ReviewScore = await scoreReview(run.report, run.manifest);
          rows.push({
            agent: agent.label,
            fixture,
            trial: t,
            bugs: run.manifest.bugs.length,
            recall: score.recall,
            precision: score.precision,
            falsePositives: score.falsePositives,
            durationMs: run.metrics.durationMs,
            judgeFailed: score.judgeFailed,
            comment: score.comment,
          });
          console.log(
            score.judgeFailed
              ? 'judge failed'
              : `recall ${(score.recall * 100).toFixed(0)}% · precision ${(score.precision * 100).toFixed(0)}% · FP ${score.falsePositives} · found [${score.found.join(', ')}]`,
          );
        } catch (err: any) {
          console.log(`ERROR: ${err.message}`);
          rows.push({ agent: agent.label, fixture, trial: t, bugs: 0, recall: 0, precision: 0, falsePositives: 0, durationMs: 0, judgeFailed: true });
        }
      }
    }
  }

  // Per-agent summary (exclude judge failures from quality averages).
  console.log('\n=== Summary (per agent) ===');
  console.log('agent                          recall   precision  avg FP   runs');
  for (const agent of agents) {
    const scored = rows.filter((r) => r.agent === agent.label && !r.judgeFailed);
    const recall = avg(scored.map((r) => r.recall));
    const precision = avg(scored.map((r) => r.precision));
    const fp = avg(scored.map((r) => r.falsePositives));
    console.log(
      `${agent.label.padEnd(30)} ${`${(recall * 100).toFixed(0)}%`.padEnd(8)} ${`${(precision * 100).toFixed(0)}%`.padEnd(10)} ${String(fp).padEnd(8)} ${scored.length}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
