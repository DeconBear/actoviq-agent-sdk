import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BenchmarkReport } from './types.js';

const repoRoot = process.cwd();
const rawArgs = stripRunnerOverrides(process.argv.slice(2));
const defaultArgs = rawArgs.length > 0 ? rawArgs : ['--cases', 'bench/cases/smoke/*.json'];
const cleanReportDir = 'bench/reports/clean-sdk';
const bridgeReportDir = 'bench/reports/bridge-sdk';
const officialReportDir = 'bench/reports/official-claude-sdk';

interface ParitySummary {
  generatedAt: string;
  clean: { totalTrials: number; passedTrials: number; passRate: number };
  bridge: { totalTrials: number; passedTrials: number; passRate: number };
  official: { totalTrials: number; passedTrials: number; passRate: number };
  caseComparison: Array<{
    caseId: string;
    cleanPassed: boolean;
    bridgePassed: boolean;
    officialPassed: boolean;
    cleanScore: number;
    bridgeScore: number;
    officialScore: number;
  }>;
}

const cleanExitCode = await runBenchmark('clean-sdk', [
  ...defaultArgs,
  '--agent-command',
  `tsx ${JSON.stringify(path.join(repoRoot, 'bench', 'agents', 'clean-sdk-runner.ts'))}`,
  '--report-dir',
  cleanReportDir,
]);

const bridgeExitCode = await runBenchmark('bridge-sdk', [
  ...defaultArgs,
  '--agent-command',
  `tsx ${JSON.stringify(path.join(repoRoot, 'bench', 'agents', 'bridge-sdk-runner.ts'))}`,
  '--report-dir',
  bridgeReportDir,
]);

const officialExitCode = await runBenchmark('official-claude-sdk', [
  ...defaultArgs,
  '--agent-command',
  `tsx ${JSON.stringify(path.join(repoRoot, 'bench', 'agents', 'official-claude-sdk-runner.ts'))}`,
  '--report-dir',
  officialReportDir,
]);

await writeParityReport(cleanReportDir, bridgeReportDir, officialReportDir);

if (cleanExitCode !== 0 || bridgeExitCode !== 0 || officialExitCode !== 0) {
  process.exitCode = 1;
}

async function runBenchmark(label: string, args: string[]): Promise<number> {
  console.log(`\n=== ${label} benchmark ===`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bench/runner.ts', ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function stripRunnerOverrides(args: string[]): string[] {
  const result: string[] = [];
  const optionsWithValues = new Set(['--agent-command', '--report-dir']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === '--use-gold') {
      continue;
    }
    if (optionsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function writeParityReport(cleanDir: string, bridgeDir: string, officialDir: string): Promise<void> {
  const clean = await readJsonReport(path.join(repoRoot, cleanDir, 'latest.json'));
  const bridge = await readJsonReport(path.join(repoRoot, bridgeDir, 'latest.json'));
  const official = await readJsonReport(path.join(repoRoot, officialDir, 'latest.json'));
  const reportDir = path.join(repoRoot, 'bench', 'reports', 'parity');
  await mkdir(reportDir, { recursive: true });

  const summary: ParitySummary = {
    generatedAt: new Date().toISOString(),
    clean: summarize(clean),
    bridge: summarize(bridge),
    official: summarize(official),
    caseComparison: compareCases(clean, bridge, official),
  };
  await writeFile(path.join(reportDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(reportDir, 'latest.md'), renderMarkdown(summary), 'utf8');
  console.log(`\nParity report written to ${path.join(reportDir, 'latest.md')}`);
}

async function readJsonReport(filePath: string): Promise<BenchmarkReport> {
  return JSON.parse(await readFile(filePath, 'utf8')) as BenchmarkReport;
}

function summarize(report: BenchmarkReport): { totalTrials: number; passedTrials: number; passRate: number } {
  return {
    totalTrials: report.totalTrials,
    passedTrials: report.passedTrials,
    passRate: report.passRate,
  };
}

function compareCases(clean: BenchmarkReport, bridge: BenchmarkReport, official: BenchmarkReport): Array<{
  caseId: string;
  cleanPassed: boolean;
  bridgePassed: boolean;
  officialPassed: boolean;
  cleanScore: number;
  bridgeScore: number;
  officialScore: number;
}> {
  const cleanByCase = new Map(clean.cases.map((trial) => [`${trial.caseId}#${trial.trial}`, trial]));
  const officialByCase = new Map(official.cases.map((trial) => [`${trial.caseId}#${trial.trial}`, trial]));
  return bridge.cases.map((bridgeTrial) => {
    const cleanTrial = cleanByCase.get(`${bridgeTrial.caseId}#${bridgeTrial.trial}`);
    const officialTrial = officialByCase.get(`${bridgeTrial.caseId}#${bridgeTrial.trial}`);
    return {
      caseId: `${bridgeTrial.caseId}#${bridgeTrial.trial}`,
      cleanPassed: cleanTrial?.passed ?? false,
      bridgePassed: bridgeTrial.passed,
      officialPassed: officialTrial?.passed ?? false,
      cleanScore: cleanTrial?.score.total ?? 0,
      bridgeScore: bridgeTrial.score.total,
      officialScore: officialTrial?.score.total ?? 0,
    };
  });
}

function renderMarkdown(summary: ParitySummary): string {
  const lines = [
    '# Actoviq Runtime Parity Benchmark',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    '| Runtime | Passed | Total | Pass Rate |',
    '|---|---:|---:|---:|',
    `| Clean SDK | ${summary.clean.passedTrials} | ${summary.clean.totalTrials} | ${(summary.clean.passRate * 100).toFixed(2)}% |`,
    `| Bridge SDK | ${summary.bridge.passedTrials} | ${summary.bridge.totalTrials} | ${(summary.bridge.passRate * 100).toFixed(2)}% |`,
    `| Official Claude Agent SDK | ${summary.official.passedTrials} | ${summary.official.totalTrials} | ${(summary.official.passRate * 100).toFixed(2)}% |`,
    '',
    '| Case | Clean | Bridge | Official | Clean Score | Bridge Score | Official Score |',
    '|---|---|---|---|---:|---:|---:|',
  ];
  for (const item of summary.caseComparison) {
    lines.push(`| ${item.caseId} | ${item.cleanPassed ? 'pass' : 'fail'} | ${item.bridgePassed ? 'pass' : 'fail'} | ${
      item.officialPassed ? 'pass' : 'fail'
    } | ${item.cleanScore.toFixed(3)} | ${item.bridgeScore.toFixed(3)} | ${item.officialScore.toFixed(3)} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
