import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ActoviqBackgroundTaskRecord,
  ActoviqDreamConfig,
  ActoviqDreamPaths,
  ActoviqDreamRunOptions,
  ActoviqDreamRunResult,
  ActoviqDreamState,
  AgentRunResult,
  StoredSession,
} from '../types.js';
import type { ActoviqMemoryApi } from './actoviqMemory.js';
import { asError } from '../runtime/helpers.js';

const DREAM_LOCK_FILE = '.consolidate-lock';
const HOLDER_STALE_MS = 60 * 60 * 1000;
const DEFAULT_DREAM_CONFIG: ActoviqDreamConfig = {
  minHours: 24,
  minSessions: 5,
  scanIntervalMs: 10 * 60 * 1000,
};

interface BuildActoviqDreamStateOptions {
  currentSessionId?: string;
}

export interface PreparedActoviqDreamExecution {
  prompt: string;
  trigger: 'manual' | 'auto';
  paths: ActoviqDreamPaths;
  state: ActoviqDreamState;
  touchedSessions: string[];
  currentSessionId?: string;
  priorMtime: number;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ActoviqDreamBindings {
  listSessions: () => Promise<StoredSession[]>;
  runExecution: (request: PreparedActoviqDreamExecution) => Promise<ActoviqDreamRunResult>;
  launchBackgroundExecution: (
    request: PreparedActoviqDreamExecution,
  ) => Promise<ActoviqBackgroundTaskRecord>;
}

export class ActoviqDreamApi {
  private lastSessionScanAt = 0;

  constructor(
    private readonly memory: ActoviqMemoryApi,
    private readonly bindings: ActoviqDreamBindings,
    private readonly defaults: {
      projectPath: string;
      sessionDirectory: string;
      config?: Partial<ActoviqDreamConfig>;
    },
  ) {}

  config(): ActoviqDreamConfig {
    return {
      ...DEFAULT_DREAM_CONFIG,
      ...(this.defaults.config ?? {}),
    };
  }

  async state(options: BuildActoviqDreamStateOptions = {}): Promise<ActoviqDreamState> {
    const [memoryState, sessions] = await Promise.all([
      this.memory.state({
        projectPath: this.defaults.projectPath,
      }),
      this.bindings.listSessions(),
    ]);
    const paths = toDreamPaths(memoryState.paths, this.defaults.sessionDirectory);
    const lastConsolidatedAtMs = await readActoviqLastConsolidatedAt(paths);
    const lockHeld = await isActoviqDreamLockHeld(paths);
    const touchedSessions = listActoviqSessionsTouchedSince(
      sessions,
      lastConsolidatedAtMs,
      this.defaults.projectPath,
      options.currentSessionId,
    );
    const hoursSinceLastConsolidated = (Date.now() - lastConsolidatedAtMs) / 3_600_000;
    const enabled = memoryState.enabled.autoDream;
    const autoMemoryEnabled = memoryState.enabled.autoMemory;
    let blockedReason: ActoviqDreamState['blockedReason'];

    if (!autoMemoryEnabled || !enabled) {
      blockedReason = 'disabled';
    } else if (hoursSinceLastConsolidated < this.config().minHours) {
      blockedReason = 'time_gate';
    } else if (touchedSessions.length < this.config().minSessions) {
      blockedReason = 'session_gate';
    } else if (lockHeld) {
      blockedReason = 'locked';
    }

    return {
      enabled,
      autoMemoryEnabled,
      config: this.config(),
      paths,
      currentSessionId: options.currentSessionId,
      lastConsolidatedAtMs,
      lastConsolidatedAt:
        lastConsolidatedAtMs > 0 ? new Date(lastConsolidatedAtMs).toISOString() : undefined,
      hoursSinceLastConsolidated,
      sessionsSinceLastConsolidated: touchedSessions,
      lockHeld,
      canRun: blockedReason == null,
      blockedReason,
    };
  }

  async run(options: ActoviqDreamRunOptions = {}): Promise<ActoviqDreamRunResult> {
    return this.executeDream('manual', {
      force: options.force ?? true,
      background: false,
      currentSessionId: options.currentSessionId,
      extraContext: options.extraContext,
      model: options.model,
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
  }

  async maybeAutoDream(options: ActoviqDreamRunOptions = {}): Promise<ActoviqDreamRunResult> {
    return this.executeDream('auto', {
      force: options.force ?? false,
      background: options.background ?? true,
      currentSessionId: options.currentSessionId,
      extraContext: options.extraContext,
      model: options.model,
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
  }

  async recordConsolidation(): Promise<void> {
    const memoryPaths = await this.memory.paths({
      projectPath: this.defaults.projectPath,
    });
    await recordActoviqConsolidation(toDreamPaths(memoryPaths, this.defaults.sessionDirectory));
  }

  private async executeDream(
    trigger: 'manual' | 'auto',
    options: Required<Pick<ActoviqDreamRunOptions, 'force' | 'background'>> &
      Omit<ActoviqDreamRunOptions, 'force' | 'background'>,
  ): Promise<ActoviqDreamRunResult> {
    const state = await this.state({
      currentSessionId: options.currentSessionId,
    });

    if (trigger === 'auto' && !options.force) {
      if (!state.autoMemoryEnabled || !state.enabled) {
        return skippedDreamResult(trigger, state, state.blockedReason ?? 'disabled');
      }
      if (state.hoursSinceLastConsolidated < state.config.minHours) {
        return skippedDreamResult(trigger, state, 'time_gate');
      }
      const sinceScanMs = Date.now() - this.lastSessionScanAt;
      if (sinceScanMs < state.config.scanIntervalMs) {
        return skippedDreamResult(trigger, state, 'scan_throttled');
      }
      this.lastSessionScanAt = Date.now();
      if (state.sessionsSinceLastConsolidated.length < state.config.minSessions) {
        return skippedDreamResult(trigger, state, 'session_gate');
      }
      if (state.lockHeld) {
        return skippedDreamResult(trigger, state, 'locked');
      }
    }

    if (!options.force && state.lockHeld) {
      return skippedDreamResult(trigger, state, 'locked');
    }

    const priorMtime = await tryAcquireActoviqConsolidationLock(state.paths);
    if (priorMtime == null) {
      const lockedState = {
        ...state,
        lockHeld: true,
        canRun: false,
        blockedReason: 'locked' as const,
      };
      return skippedDreamResult(trigger, lockedState, 'locked');
    }

    const execution: PreparedActoviqDreamExecution = {
      prompt: buildActoviqDreamPrompt(
        state.paths,
        state.sessionsSinceLastConsolidated,
        options.extraContext,
      ),
      trigger,
      paths: state.paths,
      state,
      touchedSessions: [...state.sessionsSinceLastConsolidated],
      currentSessionId: options.currentSessionId,
      priorMtime,
      model: options.model,
      maxTokens: options.maxTokens,
      signal: options.signal,
    };

    if (options.background) {
      try {
        const task = await this.bindings.launchBackgroundExecution(execution);
        return {
          success: true,
          skipped: false,
          trigger,
          state,
          touchedSessions: execution.touchedSessions,
          touchedFiles: [],
          task,
        };
      } catch (error) {
        await rollbackActoviqConsolidationLock(state.paths, priorMtime);
        throw error;
      }
    }

    return this.bindings.runExecution(execution);
  }
}

export function createActoviqDreamApi(
  memory: ActoviqMemoryApi,
  bindings: ActoviqDreamBindings,
  defaults: {
    projectPath: string;
    sessionDirectory: string;
    config?: Partial<ActoviqDreamConfig>;
  },
): ActoviqDreamApi {
  return new ActoviqDreamApi(memory, bindings, defaults);
}

export function toDreamPaths(paths: {
  autoMemoryDir: string;
  teamMemoryDir: string;
  autoMemoryEntrypoint: string;
  teamMemoryEntrypoint: string;
}, sessionDirectory: string): ActoviqDreamPaths {
  return {
    memoryDir: paths.autoMemoryDir,
    teamMemoryDir: paths.teamMemoryDir,
    memoryEntrypoint: paths.autoMemoryEntrypoint,
    teamMemoryEntrypoint: paths.teamMemoryEntrypoint,
    transcriptDir: path.join(sessionDirectory, 'sessions'),
    lockPath: path.join(paths.autoMemoryDir, DREAM_LOCK_FILE),
  };
}

export async function ensureActoviqDreamLayout(paths: ActoviqDreamPaths): Promise<void> {
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.teamMemoryDir, { recursive: true });
  await mkdir(paths.transcriptDir, { recursive: true });
  await ensureTextFile(paths.memoryEntrypoint);
  await ensureTextFile(paths.teamMemoryEntrypoint);
}

export async function readActoviqLastConsolidatedAt(paths: ActoviqDreamPaths): Promise<number> {
  try {
    const stats = await stat(paths.lockPath);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

export async function isActoviqDreamLockHeld(paths: ActoviqDreamPaths): Promise<boolean> {
  try {
    const [stats, raw] = await Promise.all([
      stat(paths.lockPath),
      readFile(paths.lockPath, 'utf8').catch(() => ''),
    ]);
    if (Date.now() - stats.mtimeMs >= HOLDER_STALE_MS) {
      return false;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? isProcessRunning(pid) : true;
  } catch {
    return false;
  }
}

export async function tryAcquireActoviqConsolidationLock(
  paths: ActoviqDreamPaths,
): Promise<number | null> {
  let previousMtime: number | undefined;
  let holderPid: number | undefined;

  try {
    const [stats, raw] = await Promise.all([stat(paths.lockPath), readFile(paths.lockPath, 'utf8')]);
    previousMtime = stats.mtimeMs;
    const parsed = Number.parseInt(raw.trim(), 10);
    holderPid = Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    previousMtime = undefined;
  }

  if (
    previousMtime != null &&
    Date.now() - previousMtime < HOLDER_STALE_MS &&
    holderPid != null &&
    isProcessRunning(holderPid)
  ) {
    return null;
  }

  await mkdir(path.dirname(paths.lockPath), { recursive: true });
  await writeFile(paths.lockPath, `${process.pid}\n`, 'utf8');
  const verify = await readFile(paths.lockPath, 'utf8').catch(() => '');
  if (Number.parseInt(verify.trim(), 10) !== process.pid) {
    return null;
  }
  return previousMtime ?? 0;
}

export async function rollbackActoviqConsolidationLock(
  paths: ActoviqDreamPaths,
  priorMtime: number,
): Promise<void> {
  try {
    if (priorMtime === 0) {
      await unlink(paths.lockPath);
      return;
    }
    await writeFile(paths.lockPath, '', 'utf8');
    const seconds = priorMtime / 1000;
    await utimes(paths.lockPath, seconds, seconds);
  } catch {
    // Best effort.
  }
}

export async function recordActoviqConsolidation(paths: ActoviqDreamPaths): Promise<void> {
  await mkdir(path.dirname(paths.lockPath), { recursive: true });
  await writeFile(paths.lockPath, `${process.pid}\n`, 'utf8');
}

export function listActoviqSessionsTouchedSince(
  sessions: readonly StoredSession[],
  sinceMs: number,
  workDir: string,
  currentSessionId?: string,
): string[] {
  return sessions
    .filter((session) => session.id !== currentSessionId)
    .filter(isActoviqDreamEligibleSession)
    .filter((session) => isSessionInProject(session, workDir))
    .filter((session) => getSessionTouchedAt(session) > sinceMs)
    .map((session) => session.id);
}

export function buildActoviqDreamPrompt(
  paths: ActoviqDreamPaths,
  touchedSessions: readonly string[],
  extraContext?: string,
): string {
  const additionalContext = [
    touchedSessions.length > 0
      ? `Sessions since last consolidation (${touchedSessions.length}):\n${touchedSessions.map(id => `- ${id}`).join('\n')}`
      : undefined,
    extraContext?.trim() ? extraContext.trim() : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n');

  return [
    '# Dream: Memory Consolidation',
    '',
    'You are performing a reflective memory-consolidation pass.',
    'Synthesize what has been learned recently into durable, well-organized memories so future sessions can orient quickly.',
    '',
    `Primary memory directory: \`${paths.memoryDir}\``,
    `Team memory directory: \`${paths.teamMemoryDir}\``,
    `Primary index: \`${paths.memoryEntrypoint}\``,
    `Team index: \`${paths.teamMemoryEntrypoint}\``,
    `Session store: \`${paths.transcriptDir}\``,
    '',
    'Use only the clean file tools available in this run: Read, Write, Edit, Glob, and Grep.',
    'Always use absolute paths. Search narrowly. Do not read or rewrite large histories unless they are directly relevant.',
    '',
    '## Phase 1 - Orient',
    '',
    '- Inspect the memory directories and their indexes before making changes.',
    '- Read existing memory files first so you improve them instead of creating duplicates.',
    '',
    '## Phase 2 - Gather recent signal',
    '',
    '- Search recent session files for durable facts, recurring workflow constraints, and corrected decisions.',
    '- Prefer narrow Grep queries against the session store over broad full-file reads.',
    '',
    '## Phase 3 - Consolidate',
    '',
    '- Update existing memory files when possible.',
    '- Create new memory files only when the information does not fit an existing topic.',
    '- Convert relative dates to absolute dates.',
    '- Remove or correct contradicted information instead of duplicating it.',
    '',
    '## Phase 4 - Prune and index',
    '',
    '- Keep each MEMORY.md file as a concise index rather than a content dump.',
    '- Each index entry should be a short single-line pointer to a topic file.',
    '- Remove stale or redundant index entries.',
    '',
    'Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so clearly.',
    additionalContext ? `\n## Additional context\n\n${additionalContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function skippedDreamResult(
  trigger: 'manual' | 'auto',
  state: ActoviqDreamState,
  reason: NonNullable<ActoviqDreamState['blockedReason']>,
): ActoviqDreamRunResult {
  return {
    success: true,
    skipped: true,
    trigger,
    reason,
    state: {
      ...state,
      canRun: false,
      blockedReason: reason,
    },
    touchedSessions: [...state.sessionsSinceLastConsolidated],
    touchedFiles: [],
  };
}

function getSessionTouchedAt(session: StoredSession): number {
  const raw = session.lastRunAt ?? session.updatedAt ?? session.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isActoviqDreamEligibleSession(
  session: Pick<StoredSession, 'metadata'>,
): boolean {
  const metadata = session.metadata ?? {};
  return (
    typeof metadata.__actoviqSwarmTeam !== 'string' &&
    typeof metadata.__actoviqTeammateName !== 'string' &&
    typeof metadata.__actoviqBackgroundParentRunId !== 'string' &&
    typeof metadata.__actoviqBackgroundParentSessionId !== 'string' &&
    typeof metadata.__actoviqSkillFork !== 'string'
  );
}

function isSessionInProject(session: StoredSession, workDir: string): boolean {
  const sessionWorkDir = session.metadata?.__actoviqWorkDir;
  if (typeof sessionWorkDir !== 'string' || sessionWorkDir.trim().length === 0) {
    return true;
  }
  return normalizePathForCompare(sessionWorkDir) === normalizePathForCompare(workDir);
}

function normalizePathForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const normalized = asError(error) as Error & { code?: string };
    return normalized.code === 'EPERM';
  }
}

async function ensureTextFile(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '', 'utf8');
  }
}
