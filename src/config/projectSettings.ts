import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getHadamardProjectSessionDirectory } from './projectSessionDirectory.js';

export type ProjectWorkMode = 'coding' | 'daily';
export type DreamExecutionProfileRef =
  | { kind: 'config'; name: string }
  | { kind: 'agent'; name: string };

export interface ProjectMemorySettings {
  compact: {
    enabled: boolean;
    autoCompactTokenLimit?: number;
    autoCompactTokenLimitScope: 'total' | 'body_after_prefix';
  };
  durableMemory: {
    use: boolean;
    autoDream: boolean;
    dreamExecutionProfile?: DreamExecutionProfileRef;
    /** Local HH:mm for GUI-scheduled daily dream (default 03:00). */
    dailyDreamTimeLocal: string;
    /** YYYY-MM-DD of last GUI-triggered scheduled dream run. */
    lastScheduledDreamDate?: string;
    minRolloutIdleHours: number;
    maxRolloutAgeDays: number;
    maxRolloutsPerStartup: number;
  };
}

export type ProjectSettings = {
  workMode: ProjectWorkMode;
  customPrompt: string;
  projectRules: string;
  memory: ProjectMemorySettings;
  updatedAt?: string;
};

export type ProjectMemorySettingsPatch = {
  compact?: Partial<ProjectMemorySettings['compact']>;
  durableMemory?: Omit<Partial<ProjectMemorySettings['durableMemory']>, 'dreamExecutionProfile'> & {
    dreamExecutionProfile?: DreamExecutionProfileRef | null;
  };
};

export const DEFAULT_PROJECT_MEMORY_SETTINGS: ProjectMemorySettings = {
  compact: {
    enabled: true,
    autoCompactTokenLimitScope: 'total',
  },
  durableMemory: {
    use: true,
    autoDream: false,
    dailyDreamTimeLocal: '03:00',
    minRolloutIdleHours: 12,
    maxRolloutAgeDays: 30,
    maxRolloutsPerStartup: 6,
  },
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  workMode: 'coding',
  customPrompt: '',
  projectRules: '',
  memory: structuredClone(DEFAULT_PROJECT_MEMORY_SETTINGS),
};

export function isProjectWorkMode(value: unknown): value is ProjectWorkMode {
  return value === 'coding' || value === 'daily';
}

export function projectSettingsPath(workDir: string, homeDir: string): string {
  return path.join(getHadamardProjectSessionDirectory(workDir, homeDir), 'project-settings.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeDreamProfile(value: unknown): DreamExecutionProfileRef | undefined {
  if (!isRecord(value)) return undefined;
  if ((value.kind !== 'config' && value.kind !== 'agent') || typeof value.name !== 'string') {
    return undefined;
  }
  const name = value.name.trim();
  return name ? { kind: value.kind, name } : undefined;
}

function normalizeDailyDreamTimeLocal(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.dailyDreamTimeLocal;
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.dailyDreamTimeLocal;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.dailyDreamTimeLocal;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeScheduledDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeMemorySettings(value: unknown): ProjectMemorySettings {
  const memory = isRecord(value) ? value : {};
  const durableMemory = isRecord(memory.durableMemory) ? memory.durableMemory : {};
  return {
    compact: {
      // Project settings always keep automatic compact on; the threshold is
      // derived from the active model context window (90% ceiling). Scope is
      // fixed to total context — not user-configurable.
      enabled: true,
      autoCompactTokenLimitScope: 'total',
    },
    durableMemory: {
      use: typeof durableMemory.use === 'boolean'
        ? durableMemory.use
        : DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.use,
      autoDream: durableMemory.autoDream === true,
      dailyDreamTimeLocal: normalizeDailyDreamTimeLocal(durableMemory.dailyDreamTimeLocal),
      ...(normalizeScheduledDate(durableMemory.lastScheduledDreamDate)
        ? { lastScheduledDreamDate: normalizeScheduledDate(durableMemory.lastScheduledDreamDate) }
        : {}),
      ...(normalizeDreamProfile(durableMemory.dreamExecutionProfile)
        ? { dreamExecutionProfile: normalizeDreamProfile(durableMemory.dreamExecutionProfile) }
        : {}),
      minRolloutIdleHours: positiveInteger(
        durableMemory.minRolloutIdleHours,
        DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.minRolloutIdleHours,
      ),
      maxRolloutAgeDays: positiveInteger(
        durableMemory.maxRolloutAgeDays,
        DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.maxRolloutAgeDays,
      ),
      maxRolloutsPerStartup: Math.min(
        positiveInteger(
          durableMemory.maxRolloutsPerStartup,
          DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.maxRolloutsPerStartup,
        ),
        128,
      ),
    },
  };
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  if (!isRecord(raw)) return structuredClone(DEFAULT_PROJECT_SETTINGS);
  return {
    workMode: isProjectWorkMode(raw.workMode)
      ? raw.workMode
      : DEFAULT_PROJECT_SETTINGS.workMode,
    customPrompt: typeof raw.customPrompt === 'string' ? raw.customPrompt : '',
    projectRules: typeof raw.projectRules === 'string' ? raw.projectRules : '',
    memory: normalizeMemorySettings(raw.memory),
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  };
}

export async function readProjectSettings(
  workDir: string,
  homeDir: string,
): Promise<ProjectSettings> {
  try {
    return normalizeProjectSettings(
      JSON.parse(await readFile(projectSettingsPath(workDir, homeDir), 'utf8')),
    );
  } catch {
    return structuredClone(DEFAULT_PROJECT_SETTINGS);
  }
}

/** Read only fields explicitly stored by the project, preserving global-default precedence. */
export async function readProjectMemorySettingsPatch(
  workDir: string,
  homeDir: string,
): Promise<ProjectMemorySettingsPatch | undefined> {
  try {
    const raw = JSON.parse(await readFile(projectSettingsPath(workDir, homeDir), 'utf8')) as unknown;
    if (!isRecord(raw) || !isRecord(raw.memory)) return undefined;
    const memory = raw.memory;
    const patch: ProjectMemorySettingsPatch = {};
    if (isRecord(memory.compact)) {
      patch.compact = {
        enabled: true,
        autoCompactTokenLimitScope: 'total',
      };
    }
    if (isRecord(memory.durableMemory)) {
      const profile = normalizeDreamProfile(memory.durableMemory.dreamExecutionProfile);
      patch.durableMemory = {
        ...(typeof memory.durableMemory.use === 'boolean' ? { use: memory.durableMemory.use } : {}),
        ...(typeof memory.durableMemory.autoDream === 'boolean'
          ? { autoDream: memory.durableMemory.autoDream }
          : {}),
        ...(typeof memory.durableMemory.dailyDreamTimeLocal === 'string'
          ? { dailyDreamTimeLocal: normalizeDailyDreamTimeLocal(memory.durableMemory.dailyDreamTimeLocal) }
          : {}),
        ...(normalizeScheduledDate(memory.durableMemory.lastScheduledDreamDate)
          ? { lastScheduledDreamDate: normalizeScheduledDate(memory.durableMemory.lastScheduledDreamDate) }
          : {}),
        ...(profile ? { dreamExecutionProfile: profile } : {}),
        ...(positiveInteger(memory.durableMemory.minRolloutIdleHours, 0)
          ? { minRolloutIdleHours: positiveInteger(memory.durableMemory.minRolloutIdleHours, 0) }
          : {}),
        ...(positiveInteger(memory.durableMemory.maxRolloutAgeDays, 0)
          ? { maxRolloutAgeDays: positiveInteger(memory.durableMemory.maxRolloutAgeDays, 0) }
          : {}),
        ...(positiveInteger(memory.durableMemory.maxRolloutsPerStartup, 0)
          ? { maxRolloutsPerStartup: positiveInteger(memory.durableMemory.maxRolloutsPerStartup, 0) }
          : {}),
      };
    }
    return patch;
  } catch {
    return undefined;
  }
}

export async function writeProjectSettings(
  workDir: string,
  homeDir: string,
  patch: Partial<Omit<ProjectSettings, 'memory'>> & { memory?: ProjectMemorySettingsPatch },
): Promise<ProjectSettings> {
  const current = await readProjectSettings(workDir, homeDir);
  const memoryPatch = patch.memory ?? {};
  const memory = normalizeMemorySettings({
    ...current.memory,
    ...memoryPatch,
    compact: { ...current.memory.compact, ...(memoryPatch.compact ?? {}) },
    durableMemory: { ...current.memory.durableMemory, ...(memoryPatch.durableMemory ?? {}) },
  });
  if (memory.durableMemory.autoDream && !memory.durableMemory.dreamExecutionProfile) {
    throw new Error('Select a Dream config or agent before enabling autoDream.');
  }
  const next: ProjectSettings = {
    workMode: isProjectWorkMode(patch.workMode) ? patch.workMode : current.workMode,
    customPrompt: typeof patch.customPrompt === 'string' ? patch.customPrompt : current.customPrompt,
    projectRules: typeof patch.projectRules === 'string' ? patch.projectRules : current.projectRules,
    memory,
    updatedAt: new Date().toISOString(),
  };
  const filePath = projectSettingsPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function appendProjectSettingsToPrompt(
  base: string,
  settings: Pick<ProjectSettings, 'customPrompt' | 'projectRules'> & Record<string, unknown>,
): string {
  let out = base;
  const custom = settings.customPrompt.trim();
  if (custom) out += `\n\n# Custom instructions\n\n${custom}`;
  const rules = settings.projectRules.trim();
  if (rules) out += `\n\n# Project rules\n\n${rules}`;
  return out;
}
