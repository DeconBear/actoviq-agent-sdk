import { exec as execCallback } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { glob } from 'glob';

import type {
  BenchmarkAgentMetrics,
  BenchmarkCase,
  BenchmarkCommandResult,
  BenchmarkGrader,
  BenchmarkGraderResult,
  BenchmarkReport,
  BenchmarkScore,
  BenchmarkTrialResult,
} from './types.js';
import { appendTrajectoryEvent, readTrajectoryEvents } from './trajectory.js';

const exec = promisify(execCallback);
const DEFAULT_CASE_PATTERN = 'bench/cases/**/*.json';
const DEFAULT_REPORT_DIR = 'bench/reports';
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 10 * 1024 * 1024;

interface CliOptions {
  casePattern: string;
  reportDir: string;
  workspaceRoot?: string;
  agentCommand?: string;
  trials?: number;
  useGold: boolean;
  keepWorkspaces: boolean;
  failFast: boolean;
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const cases = await loadCases(repoRoot, options.casePattern);

  if (cases.length === 0) {
    throw new Error(`No benchmark cases matched pattern: ${options.casePattern}`);
  }

  const trialResults: BenchmarkTrialResult[] = [];
  for (const benchmarkCase of cases) {
    const trials = options.trials ?? benchmarkCase.trials ?? 1;
    for (let trial = 1; trial <= trials; trial += 1) {
      const result = await runTrial(repoRoot, benchmarkCase, trial, options);
      trialResults.push(result);
      printTrialResult(result);
      if (options.failFast && !result.passed) {
        await writeReports(repoRoot, options.reportDir, startedAt, startedAtMs, trialResults);
        process.exitCode = 1;
        return;
      }
    }
  }

  const report = await writeReports(repoRoot, options.reportDir, startedAt, startedAtMs, trialResults);
  printSummary(report);
  if (report.failedTrials > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    casePattern: DEFAULT_CASE_PATTERN,
    reportDir: DEFAULT_REPORT_DIR,
    useGold: false,
    keepWorkspaces: false,
    failFast: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--cases':
        options.casePattern = readArgValue(args, ++i, arg);
        break;
      case '--report-dir':
        options.reportDir = readArgValue(args, ++i, arg);
        break;
      case '--workspace-root':
        options.workspaceRoot = readArgValue(args, ++i, arg);
        break;
      case '--agent-command':
        options.agentCommand = readArgValue(args, ++i, arg);
        break;
      case '--trials':
        options.trials = parsePositiveInt(readArgValue(args, ++i, arg), arg);
        break;
      case '--use-gold':
        options.useGold = true;
        break;
      case '--keep-workspaces':
        options.keepWorkspaces = true;
        break;
      case '--fail-fast':
        options.failFast = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown benchmark option: ${arg}`);
    }
  }

  options.agentCommand ??= process.env.ACTOVIQ_BENCH_AGENT_COMMAND;
  return options;
}

function readArgValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: tsx bench/runner.ts [options]

Options:
  --cases <glob>             Case glob. Default: ${DEFAULT_CASE_PATTERN}
  --agent-command <command>  External agent command to run in each workspace.
  --use-gold                 Run each case's hidden goldCommand instead of an agent command.
  --trials <n>               Override per-case trial count.
  --report-dir <dir>         Report output directory. Default: ${DEFAULT_REPORT_DIR}
  --workspace-root <dir>     Parent directory for temporary workspaces.
  --keep-workspaces          Keep trial workspaces for debugging.
  --fail-fast                Stop after the first failed trial.
`);
}

async function loadCases(repoRoot: string, pattern: string): Promise<BenchmarkCase[]> {
  const matches = await glob(pattern, {
    cwd: repoRoot,
    absolute: true,
    nodir: true,
    windowsPathsNoEscape: true,
  });
  const cases = await Promise.all(
    matches.sort().map(async (filePath) => {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as BenchmarkCase;
      validateCase(parsed, filePath);
      return parsed;
    }),
  );
  return cases;
}

function validateCase(benchmarkCase: BenchmarkCase, filePath: string): void {
  const missing: string[] = [];
  if (!benchmarkCase.id) missing.push('id');
  if (!benchmarkCase.title) missing.push('title');
  if (!benchmarkCase.category) missing.push('category');
  if (!benchmarkCase.runtimeTarget) missing.push('runtimeTarget');
  if (!benchmarkCase.instruction) missing.push('instruction');
  if (!Array.isArray(benchmarkCase.graders) || benchmarkCase.graders.length === 0) {
    missing.push('graders');
  }
  if (missing.length > 0) {
    throw new Error(`${filePath} is missing required fields: ${missing.join(', ')}`);
  }
}

async function runTrial(
  repoRoot: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  options: CliOptions,
): Promise<BenchmarkTrialResult> {
  const startedAt = Date.now();
  const workspace = await createWorkspace(repoRoot, benchmarkCase, trial, options);
  const internalDir = await createInternalDirectory(repoRoot, benchmarkCase, trial, options);
  const instructionFile = path.join(internalDir, 'instruction.txt');
  const outputFile = path.join(internalDir, 'agent-output.txt');
  const trajectoryFile = path.join(internalDir, 'trajectory.jsonl');
  await writeFile(instructionFile, `${benchmarkCase.instruction}\n`, 'utf8');

  try {
    const env = {
      ...process.env,
      ACTOVIQ_BENCH_CASE_ID: benchmarkCase.id,
      ACTOVIQ_BENCH_WORKSPACE: workspace,
      ACTOVIQ_BENCH_INSTRUCTION: benchmarkCase.instruction,
      ACTOVIQ_BENCH_INSTRUCTION_FILE: instructionFile,
      ACTOVIQ_BENCH_OUTPUT_FILE: outputFile,
      ACTOVIQ_BENCH_TRAJECTORY_FILE: trajectoryFile,
      ACTOVIQ_BENCH_INTERNAL_DIR: internalDir,
      ACTOVIQ_BENCH_RUNTIME_TARGET: benchmarkCase.runtimeTarget,
    };

    const setupCommand = benchmarkCase.setupCommand
      ? await runCommand(
          renderCommand(benchmarkCase.setupCommand, repoRoot, benchmarkCase, workspace, instructionFile, outputFile),
          workspace,
          env,
        )
      : undefined;
    await appendCommandEvent(trajectoryFile, benchmarkCase, trial, 'setup_command', setupCommand);

    const commandToRun = options.useGold ? benchmarkCase.goldCommand : options.agentCommand;
    const agentCommand = commandToRun
      ? await runCommand(
          renderCommand(commandToRun, repoRoot, benchmarkCase, workspace, instructionFile, outputFile),
          workspace,
          env,
          benchmarkCase.budget?.maxSeconds ? benchmarkCase.budget.maxSeconds * 1000 : undefined,
        )
      : undefined;
    await appendCommandEvent(trajectoryFile, benchmarkCase, trial, 'agent_command', agentCommand);
    const agentMetrics = await readAgentMetrics(outputFile);
    const policyResult = await auditBenchmarkInternalAccess(repoRoot, workspace, trajectoryFile);
    const auditedAgentMetrics = policyResult.accessCount > 0
      ? {
          ...agentMetrics,
          benchmarkInternalAccessCount: policyResult.accessCount,
        }
      : agentMetrics;

    const graders: BenchmarkGraderResult[] = [];
    for (const grader of benchmarkCase.graders) {
      const graderResult = await runGrader(grader, workspace, env);
      graders.push(graderResult);
      await appendGraderEvent(trajectoryFile, benchmarkCase, trial, graderResult);
    }
    graders.push(policyResult.grader);
    await appendGraderEvent(trajectoryFile, benchmarkCase, trial, policyResult.grader);

    const passed =
      (setupCommand?.exitCode ?? 0) === 0 &&
      (agentCommand?.exitCode ?? 0) === 0 &&
      graders.every((grader) => grader.passed);
    const durationMs = Date.now() - startedAt;
    const score = scoreTrial(benchmarkCase, passed, auditedAgentMetrics, durationMs);
    const archivedTrajectory = await archiveTrajectory(repoRoot, options.reportDir, benchmarkCase, trial, trajectoryFile);

    return {
      caseId: benchmarkCase.id,
      title: benchmarkCase.title,
      category: benchmarkCase.category,
      runtimeTarget: benchmarkCase.runtimeTarget,
      trial,
      workspace,
      usedGold: options.useGold,
      setupCommand,
      agentCommand,
      graders,
      agentMetrics: auditedAgentMetrics,
      trajectoryFile: archivedTrajectory?.relativePath,
      trajectoryEventCount: archivedTrajectory?.eventCount,
      score,
      passed,
      durationMs,
    };
  } finally {
    if (!options.keepWorkspaces) {
      await removeWorkspace(workspace);
      await removeWorkspace(internalDir);
    }
  }
}

async function createWorkspace(
  repoRoot: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  options: CliOptions,
): Promise<string> {
  const parent = options.workspaceRoot
    ? path.resolve(repoRoot, options.workspaceRoot)
    : os.tmpdir();
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(path.join(parent, `actoviq-bench-${benchmarkCase.id}-${trial}-`));

  if (benchmarkCase.fixture) {
    const fixturePath = path.resolve(repoRoot, benchmarkCase.fixture);
    await cp(fixturePath, workspace, { recursive: true, force: true });
  }

  return workspace;
}

async function createInternalDirectory(
  repoRoot: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  options: CliOptions,
): Promise<string> {
  const parent = options.workspaceRoot
    ? path.resolve(repoRoot, options.workspaceRoot)
    : os.tmpdir();
  await mkdir(parent, { recursive: true });
  return await mkdtemp(path.join(parent, `actoviq-bench-internal-${benchmarkCase.id}-${trial}-`));
}

function renderCommand(
  command: string,
  repoRoot: string,
  benchmarkCase: BenchmarkCase,
  workspace: string,
  instructionFile: string,
  outputFile: string,
): string {
  return command
    .replaceAll('{repoRoot}', shellQuote(repoRoot))
    .replaceAll('{cleanSdkRunner}', shellQuote(path.join(repoRoot, 'bench', 'agents', 'clean-sdk-runner.ts')))
    .replaceAll('{bridgeSdkRunner}', shellQuote(path.join(repoRoot, 'bench', 'agents', 'bridge-sdk-runner.ts')))
    .replaceAll('{officialClaudeSdkRunner}', shellQuote(path.join(repoRoot, 'bench', 'agents', 'official-claude-sdk-runner.ts')))
    .replaceAll('{caseId}', shellQuote(benchmarkCase.id))
    .replaceAll('{workspace}', shellQuote(workspace))
    .replaceAll('{instructionFile}', shellQuote(instructionFile))
    .replaceAll('{outputFile}', shellQuote(outputFile));
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

async function runGrader(
  grader: BenchmarkGrader,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<BenchmarkGraderResult> {
  switch (grader.type) {
    case 'command': {
      const command = await runCommand(grader.command, workspace, env, grader.timeoutMs);
      const expectedExitCode = grader.passExitCode ?? 0;
      return {
        type: grader.type,
        passed: command.exitCode === expectedExitCode,
        message: `Expected exit ${expectedExitCode}; got ${command.exitCode ?? 'null'}.`,
        command,
      };
    }
    case 'file_contains': {
      const filePath = resolveWorkspacePath(workspace, grader.path);
      try {
        const content = await readFile(filePath, 'utf8');
        const passed = content.includes(grader.text);
        return {
          type: grader.type,
          passed,
          message: passed
            ? `${grader.path} contains expected text.`
            : `${grader.path} does not contain expected text.`,
        };
      } catch (error) {
        return {
          type: grader.type,
          passed: false,
          message: `${grader.path} could not be read: ${errorMessage(error)}`,
        };
      }
    }
    case 'file_exists': {
      const filePath = resolveWorkspacePath(workspace, grader.path);
      const exists = await pathExists(filePath);
      return {
        type: grader.type,
        passed: exists,
        message: exists ? `${grader.path} exists.` : `${grader.path} does not exist.`,
      };
    }
    case 'file_absent': {
      const filePath = resolveWorkspacePath(workspace, grader.path);
      const exists = await pathExists(filePath);
      return {
        type: grader.type,
        passed: !exists,
        message: exists ? `${grader.path} exists.` : `${grader.path} is absent.`,
      };
    }
  }
}

async function auditBenchmarkInternalAccess(
  repoRoot: string,
  workspace: string,
  trajectoryFile: string,
): Promise<{ accessCount: number; grader: BenchmarkGraderResult }> {
  if (!(await pathExists(trajectoryFile))) {
    return {
      accessCount: 0,
      grader: {
        type: 'policy',
        passed: true,
        message: 'No trajectory file was available for benchmark-internal access audit.',
      },
    };
  }

  const forbiddenHits: string[] = [];
  const events = await readTrajectoryEvents(trajectoryFile);
  for (const event of events) {
    if (!['tool_call', 'tool_result'].includes(event.event.type)) {
      continue;
    }
    const text = `${event.event.name ?? ''}\n${event.event.inputSummary ?? ''}\n${event.event.outputSummary ?? ''}`;
    const hit = findForbiddenBenchmarkAccess(text, repoRoot, workspace);
    if (hit) {
      forbiddenHits.push(`${event.event.type}:${event.event.name ?? 'unknown'}:${hit}`);
    }
  }

  if (forbiddenHits.length === 0) {
    return {
      accessCount: 0,
      grader: {
        type: 'policy',
        passed: true,
        message: 'No benchmark-internal access detected in tool trajectory.',
      },
    };
  }

  return {
    accessCount: forbiddenHits.length,
    grader: {
      type: 'policy',
      passed: false,
      message: `Benchmark-internal access detected: ${forbiddenHits.slice(0, 5).join('; ')}`,
    },
  };
}

function findForbiddenBenchmarkAccess(text: string, repoRoot: string, workspace: string): string | undefined {
  const normalizedText = normalizeForAudit(text);
  const normalizedRepoRoot = normalizeForAudit(repoRoot);
  const normalizedWorkspace = normalizeForAudit(workspace);
  const forbiddenPatterns = [
    '.actoviq-bench',
    'actoviq-bench-internal',
    'goldcommand',
    'bench/cases',
    'bench/reports',
    'agent_runtime_benchmark_results',
    'agent_capability_benchmark_design',
    'clean-sdk-runner.ts',
    'bridge-sdk-runner.ts',
    'official-claude-sdk-runner.ts',
    'actoviq_bench_output_file',
    'actoviq_bench_trajectory_file',
    'actoviq_bench_internal_dir',
  ];

  for (const pattern of forbiddenPatterns) {
    if (normalizedText.includes(pattern)) {
      return pattern;
    }
  }

  if (
    normalizedRepoRoot &&
    normalizedText.includes(normalizedRepoRoot) &&
    (!normalizedWorkspace || !normalizedText.includes(normalizedWorkspace))
  ) {
    return 'repo-root';
  }

  return undefined;
}

function normalizeForAudit(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function resolveWorkspacePath(workspace: string, relativePath: string): string {
  const resolved = path.resolve(workspace, relativePath);
  const normalizedWorkspace = path.resolve(workspace);
  const relative = path.relative(normalizedWorkspace, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Grader path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeWorkspace(workspace: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.warn(`Warning: could not remove benchmark workspace ${workspace}: ${errorMessage(error)}`);
        return;
      }
      await delay(250 * attempt);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<BenchmarkCommandResult> {
  const startedAt = Date.now();
  try {
    const result = await exec(command, {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
    });
    return {
      command,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  } catch (error) {
    const nodeError = error as {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string | null;
    };
    return {
      command,
      exitCode: typeof nodeError.code === 'number' ? nodeError.code : null,
      stdout: nodeError.stdout ?? '',
      stderr: nodeError.stderr ?? errorMessage(error),
      durationMs: Date.now() - startedAt,
      timedOut: nodeError.killed === true || nodeError.signal === 'SIGTERM',
    };
  }
}

async function appendCommandEvent(
  trajectoryFile: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  name: string,
  command: BenchmarkCommandResult | undefined,
): Promise<void> {
  if (!command) {
    return;
  }
  await appendTrajectoryEvent(trajectoryFile, {
    runtime: benchmarkCase.runtimeTarget,
    caseId: benchmarkCase.id,
    trial,
    actor: { type: 'harness', name },
    event: {
      type: 'command_verification',
      name,
      inputSummary: command.command,
      outputSummary: command.exitCode === 0 ? 'exit 0' : `exit ${command.exitCode ?? 'null'}`,
      isError: command.exitCode !== 0 || command.timedOut,
      durationMs: command.durationMs,
      data: {
        exitCode: command.exitCode,
        timedOut: command.timedOut,
      },
    },
  });
}

async function appendGraderEvent(
  trajectoryFile: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  grader: BenchmarkGraderResult,
): Promise<void> {
  await appendTrajectoryEvent(trajectoryFile, {
    runtime: benchmarkCase.runtimeTarget,
    caseId: benchmarkCase.id,
    trial,
    actor: { type: 'grader', name: grader.type },
    event: {
      type: 'grader_result',
      name: grader.type,
      outputSummary: grader.message,
      isError: !grader.passed,
      durationMs: grader.command?.durationMs,
      data: {
        passed: grader.passed,
        exitCode: grader.command?.exitCode,
      },
    },
  });
}

async function archiveTrajectory(
  repoRoot: string,
  reportDir: string,
  benchmarkCase: BenchmarkCase,
  trial: number,
  trajectoryFile: string,
): Promise<{ relativePath: string; eventCount: number } | undefined> {
  if (!(await pathExists(trajectoryFile))) {
    return undefined;
  }
  const events = await readTrajectoryEvents(trajectoryFile);
  const relativePath = path.join(
    reportDir,
    'trajectories',
    `${sanitizeFileName(benchmarkCase.id)}-${trial}.jsonl`,
  );
  const destination = path.resolve(repoRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(trajectoryFile, destination);
  return {
    relativePath,
    eventCount: events.length,
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

async function readAgentMetrics(outputFile: string): Promise<BenchmarkAgentMetrics | undefined> {
  if (!(await pathExists(outputFile))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(outputFile, 'utf8')) as unknown;
    const source = isRecord(parsed) && isRecord(parsed.metrics) ? parsed.metrics : parsed;
    if (!isRecord(source)) {
      return undefined;
    }

    const toolCalls = normalizeToolCalls(source.toolCalls);
    const subagents = normalizeSubagents(source.subagents ?? source.delegatedAgents);
    const skills = normalizeStringArray(source.skills ?? source.invokedSkills);
    return {
      runtime: getString(source, 'runtime'),
      llmRequestCount: getNumber(source, 'llmRequestCount') ?? getNumber(source, 'requestCount') ?? getNumber(source, 'numTurns'),
      requestCount: getNumber(source, 'requestCount') ?? getNumber(source, 'llmRequestCount'),
      turnCount: getNumber(source, 'turnCount') ?? getNumber(source, 'numTurns'),
      toolCallCount: getNumber(source, 'toolCallCount') ?? toolCalls?.length,
      toolErrorCount: getNumber(source, 'toolErrorCount') ?? countToolErrors(toolCalls),
      subagentCallCount: getNumber(source, 'subagentCallCount') ?? subagents?.length,
      skillUseCount: getNumber(source, 'skillUseCount') ?? skills?.length,
      permissionDenialCount: getNumber(source, 'permissionDenialCount'),
      eventCount: getNumber(source, 'eventCount'),
      durationMs: getNumber(source, 'durationMs'),
      totalCostUsd: getNumber(source, 'totalCostUsd'),
      inputTokens: getNumber(source, 'inputTokens'),
      outputTokens: getNumber(source, 'outputTokens'),
      cacheReadInputTokens: getNumber(source, 'cacheReadInputTokens'),
      cacheCreationInputTokens: getNumber(source, 'cacheCreationInputTokens'),
      toolCalls,
      subagents,
      skills,
    };
  } catch (error) {
    console.warn(`Warning: could not parse agent metrics from ${outputFile}: ${errorMessage(error)}`);
    return undefined;
  }
}

function normalizeToolCalls(value: unknown): BenchmarkAgentMetrics['toolCalls'] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const name = getString(entry, 'name') ?? getString(entry, 'tool_name');
    if (!name) {
      return [];
    }
    return [{
      name,
      publicName: getString(entry, 'publicName'),
      isError: getBoolean(entry, 'isError'),
      durationMs: getNumber(entry, 'durationMs'),
      parentToolUseId: getString(entry, 'parentToolUseId') ?? getString(entry, 'parent_tool_use_id') ?? null,
    }];
  });
}

function normalizeSubagents(value: unknown): BenchmarkAgentMetrics['subagents'] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const subagents: NonNullable<BenchmarkAgentMetrics['subagents']> = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      subagents.push({ name: entry });
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const name = getString(entry, 'name') ?? getString(entry, 'subagentType') ?? getString(entry, 'subagent_type');
    subagents.push({
      name,
      description: getString(entry, 'description') ?? getString(entry, 'lastDescription'),
      taskType: getString(entry, 'taskType') ?? getString(entry, 'task_type'),
    });
  }
  return subagents.length > 0 ? subagents : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry];
    }
    if (isRecord(entry)) {
      const name = getString(entry, 'name') ?? getString(entry, 'skill') ?? getString(entry, 'skillName');
      return name ? [name] : [];
    }
    return [];
  });
  return strings.length > 0 ? [...new Set(strings)] : undefined;
}

function countToolErrors(toolCalls: BenchmarkAgentMetrics['toolCalls']): number | undefined {
  if (!toolCalls) {
    return undefined;
  }
  return toolCalls.filter((call) => call.isError).length;
}

function scoreTrial(
  benchmarkCase: BenchmarkCase,
  passed: boolean,
  metrics: BenchmarkAgentMetrics | undefined,
  durationMs: number,
): BenchmarkScore {
  const task = passed ? 1 : 0;
  const efficiency = scoreEfficiency(benchmarkCase, metrics, durationMs);
  const behavior = scoreBehavior(metrics);
  return {
    total: roundScore((task * 0.7) + (efficiency * 0.2) + (behavior * 0.1)),
    task: roundScore(task),
    efficiency: roundScore(efficiency),
    behavior: roundScore(behavior),
  };
}

function scoreEfficiency(
  benchmarkCase: BenchmarkCase,
  metrics: BenchmarkAgentMetrics | undefined,
  durationMs: number,
): number {
  const scores: number[] = [];
  if (benchmarkCase.budget?.maxSeconds) {
    scores.push(scoreBudgetValue(durationMs, benchmarkCase.budget.maxSeconds * 1000));
  }
  if (benchmarkCase.budget?.maxToolCalls && metrics?.toolCallCount != null) {
    scores.push(scoreBudgetValue(metrics.toolCallCount, benchmarkCase.budget.maxToolCalls));
  }
  const tokenCount = sumDefined(metrics?.inputTokens, metrics?.outputTokens, metrics?.cacheReadInputTokens, metrics?.cacheCreationInputTokens);
  if (benchmarkCase.budget?.maxTokens && tokenCount != null) {
    scores.push(scoreBudgetValue(tokenCount, benchmarkCase.budget.maxTokens));
  }
  if (scores.length === 0) {
    return 1;
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function scoreBehavior(metrics: BenchmarkAgentMetrics | undefined): number {
  if (!metrics) {
    return 1;
  }
  let score = 1;
  const toolCallCount = metrics.toolCallCount ?? metrics.toolCalls?.length ?? 0;
  if (toolCallCount > 0 && metrics.toolErrorCount && metrics.toolErrorCount > 0) {
    score -= Math.min(0.6, metrics.toolErrorCount / toolCallCount);
  }
  if (metrics.permissionDenialCount && metrics.permissionDenialCount > 0) {
    score -= Math.min(0.3, metrics.permissionDenialCount * 0.1);
  }
  if (metrics.benchmarkInternalAccessCount && metrics.benchmarkInternalAccessCount > 0) {
    score -= Math.min(1, metrics.benchmarkInternalAccessCount * 0.25);
  }
  return Math.max(0, score);
}

function scoreBudgetValue(actual: number, max: number): number {
  if (actual <= max) {
    return 1;
  }
  return Math.max(0, 1 - ((actual - max) / Math.max(max, 1)));
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number');
  if (defined.length === 0) {
    return undefined;
  }
  return defined.reduce((sum, value) => sum + value, 0);
}

function roundScore(value: number): number {
  return Number(value.toFixed(3));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

async function writeReports(
  repoRoot: string,
  reportDir: string,
  startedAt: string,
  startedAtMs: number,
  cases: BenchmarkTrialResult[],
): Promise<BenchmarkReport> {
  const completedAtMs = Date.now();
  const passedTrials = cases.filter((trial) => trial.passed).length;
  const averageScore = cases.length === 0
    ? 0
    : cases.reduce((sum, trial) => sum + trial.score.total, 0) / cases.length;
  const report: BenchmarkReport = {
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    totalTrials: cases.length,
    passedTrials,
    failedTrials: cases.length - passedTrials,
    passRate: cases.length === 0 ? 0 : passedTrials / cases.length,
    averageScore: roundScore(averageScore),
    cases,
  };

  const resolvedReportDir = path.resolve(repoRoot, reportDir);
  await mkdir(resolvedReportDir, { recursive: true });
  await writeFile(path.join(resolvedReportDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(resolvedReportDir, 'latest.md'), renderMarkdownReport(report), 'utf8');
  return report;
}

function renderMarkdownReport(report: BenchmarkReport): string {
  const lines = [
    '# Actoviq Benchmark Report',
    '',
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    `Pass rate: ${(report.passRate * 100).toFixed(2)}% (${report.passedTrials}/${report.totalTrials})`,
    `Average score: ${report.averageScore.toFixed(3)}`,
    '',
    '| Case | Trial | Runtime | Category | Result | Score | Duration | LLM req | Tools | Subagents | Skills | Trace events |',
    '|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const trial of report.cases) {
    lines.push(
      `| ${trial.caseId} | ${trial.trial} | ${trial.runtimeTarget} | ${trial.category} | ${
        trial.passed ? 'pass' : 'fail'
      } | ${trial.score.total.toFixed(3)} | ${trial.durationMs}ms | ${formatMetric(trial.agentMetrics?.llmRequestCount)} | ${formatMetric(
        trial.agentMetrics?.toolCallCount,
      )} | ${formatMetric(trial.agentMetrics?.subagentCallCount)} | ${formatMetric(trial.agentMetrics?.skillUseCount)} | ${formatMetric(
        trial.trajectoryEventCount,
      )} |`,
    );
  }
  const traces = report.cases.filter((trial) => trial.trajectoryFile);
  if (traces.length > 0) {
    lines.push('', '## Trajectories', '');
    for (const trial of traces) {
      lines.push(`- ${trial.caseId}#${trial.trial}: ${trial.trajectoryFile}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function printTrialResult(result: BenchmarkTrialResult): void {
  const status = result.passed ? 'PASS' : 'FAIL';
  const metrics = result.agentMetrics;
  console.log(
    `${status} ${result.caseId} trial=${result.trial} runtime=${result.runtimeTarget} score=${result.score.total.toFixed(3)} duration=${result.durationMs}ms tools=${formatMetric(
      metrics?.toolCallCount,
    )} llmReq=${formatMetric(metrics?.llmRequestCount)} subagents=${formatMetric(metrics?.subagentCallCount)} skills=${formatMetric(
      metrics?.skillUseCount,
    )}`,
  );
  for (const grader of result.graders) {
    console.log(`  - ${grader.passed ? 'pass' : 'fail'} ${grader.type}: ${grader.message}`);
  }
}

function printSummary(report: BenchmarkReport): void {
  console.log(
    `Benchmark complete: ${report.passedTrials}/${report.totalTrials} passed (${(report.passRate * 100).toFixed(2)}%), average score ${report.averageScore.toFixed(3)}.`,
  );
}

function formatMetric(value: number | undefined): string {
  return value == null ? '-' : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
