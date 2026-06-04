import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BenchmarkCase, BenchmarkCategory, BenchmarkGrader } from '../types.js';

interface ExternalTaskManifest {
  tasks: ExternalTask[];
}

interface ExternalTask {
  id: string;
  title: string;
  source: string;
  category: BenchmarkCategory;
  instruction: string;
  fixture: string;
  tags?: string[];
  budget?: BenchmarkCase['budget'];
  graders: BenchmarkGrader[];
  notes?: string;
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(args.manifest, 'utf8')) as ExternalTaskManifest;
await mkdir(args.outDir, { recursive: true });

for (const task of manifest.tasks) {
  validateTask(task);
  const benchmarkCase: BenchmarkCase = {
    id: task.id,
    title: task.title,
    category: task.category,
    runtimeTarget: 'parity',
    instruction: task.instruction,
    fixture: task.fixture,
    tags: [...new Set([task.source, 'adapted', ...(task.tags ?? [])])],
    budget: task.budget,
    graders: task.graders,
    notes: task.notes ?? `Adapted from ${task.source}.`,
  };
  const destination = path.join(args.outDir, `${sanitizeFileName(task.id)}.json`);
  await writeFile(destination, `${JSON.stringify(benchmarkCase, null, 2)}\n`, 'utf8');
  console.log(`wrote ${destination}`);
}

function parseArgs(rawArgs: string[]): { manifest: string; outDir: string } {
  let manifest: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--manifest') {
      manifest = rawArgs[++i];
    } else if (arg === '--out-dir') {
      outDir = rawArgs[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!manifest || !outDir) {
    throw new Error('Usage: tsx bench/adapters/external-task-adapter.ts --manifest <file> --out-dir <dir>');
  }
  return { manifest, outDir };
}

function validateTask(task: ExternalTask): void {
  const missing: string[] = [];
  if (!task.id) missing.push('id');
  if (!task.title) missing.push('title');
  if (!task.source) missing.push('source');
  if (!task.category) missing.push('category');
  if (!task.instruction) missing.push('instruction');
  if (!task.fixture) missing.push('fixture');
  if (!Array.isArray(task.graders) || task.graders.length === 0) missing.push('graders');
  if (missing.length > 0) {
    throw new Error(`External task is missing: ${missing.join(', ')}`);
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}
