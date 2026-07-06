#!/usr/bin/env npx tsx
/**
 * Reviewer-track runner — exercises the real `reviewer` team mode.
 *
 * Copies a fixture into an isolated temp workspace (excluding the ground-truth
 * review-manifest.json), then invokes a reviewer team over that workspace with
 * the manifest's { task, context }. The reviewer is a read-only ReAct agent, so
 * the workspace is never modified. Returns the report for the judge to score.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createModelTeam, loadDefaultActoviqSettings } from '../../src/index.js';
import type { ReviewAgent, ReviewManifest, ReviewRunMetrics } from './review-types.js';

export interface ReviewRunResult {
  manifest: ReviewManifest;
  report: string;
  metrics: ReviewRunMetrics;
}

function copyExcept(src: string, dest: string, exclude: Set<string>): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyExcept(s, d, exclude);
    else fs.copyFileSync(s, d);
  }
}

export async function runReviewer(fixture: string, agent: ReviewAgent): Promise<ReviewRunResult> {
  await loadDefaultActoviqSettings().catch(() => {});

  const fixtureDir = path.join(process.cwd(), 'bench', 'fixtures', 'review', fixture);
  const manifestPath = path.join(fixtureDir, 'review-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`review-manifest.json not found for fixture "${fixture}" at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ReviewManifest;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'actoviq-review-'));
  const start = Date.now();
  try {
    // The reviewer must NOT see the ground-truth manifest.
    copyExcept(fixtureDir, ws, new Set(['review-manifest.json']));

    const team = createModelTeam({
      name: 'bench-reviewer',
      mode: 'reviewer',
      members: [],
      reviewer: { model: agent.model },
      timeoutMs: 300_000,
      maxIterations: 16,
    });

    const result = await team.ask(manifest.task, undefined, {
      context: manifest.context,
      workDir: ws,
    });

    return {
      manifest,
      report: result.answer,
      metrics: {
        durationMs: Date.now() - start,
        toolCallCount: result.memberStatuses?.reduce((n, s) => n + (s.toolCalls ?? 0), 0) ?? 0,
        inputTokens: result.cost.totalInputTokens,
        outputTokens: result.cost.totalOutputTokens,
      },
    };
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
