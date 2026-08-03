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
  sessionMemory: {
    autoExtract: boolean;
    maxOutputTokens: number;
  };
  durableMemory: {
    use: boolean;
    autoDream: boolean;
    dreamExecutionProfile?: DreamExecutionProfileRef;
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
  sessionMemory?: Partial<ProjectMemorySettings['sessionMemory']>;
  durableMemory?: Omit<Partial<ProjectMemorySettings['durableMemory']>, 'dreamExecutionProfile'> & {
    dreamExecutionProfile?: DreamExecutionProfileRef | null;
  };
};

export const DEFAULT_PROJECT_MEMORY_SETTINGS: ProjectMemorySettings = {
  compact: {
    enabled: true,
    autoCompactTokenLimitScope: 'total',
  },
  sessionMemory: {
    autoExtract: true,
    maxOutputTokens: 10_000,
  },
  durableMemory: {
    use: true,
    autoDream: false,
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeDreamProfile(value: unknown): DreamExecutionProfileRef | undefined {
  if (!isRecord(value)) return undefined;
  if ((value.kind !== 'config' && value.kind !== 'agent') || typeof value.name !== 'string') {
    return undefined;
  }
  const name = value.name.trim();
  return name ? { kind: value.kind, name } : undefined;
}

function normalizeMemorySettings(value: unknown): ProjectMemorySettings {
  const memory = isRecord(value) ? value : {};
  const compact = isRecord(memory.compact) ? memory.compact : {};
  const sessionMemory = isRecord(memory.sessionMemory) ? memory.sessionMemory : {};
  const durableMemory = isRecord(memory.durableMemory) ? memory.durableMemory : {};
  const autoCompactTokenLimit = positiveInteger(compact.autoCompactTokenLimit, 0) || undefined;
  const maxOutputTokens = positiveInteger(
    sessionMemory.maxOutputTokens,
    DEFAULT_PROJECT_MEMORY_SETTINGS.sessionMemory.maxOutputTokens,
  );
  return {
    compact: {
      enabled: typeof compact.enabled === 'boolean'
        ? compact.enabled
        : DEFAULT_PROJECT_MEMORY_SETTINGS.compact.enabled,
      ...(autoCompactTokenLimit ? { autoCompactTokenLimit } : {}),
      autoCompactTokenLimitScope: compact.autoCompactTokenLimitScope === 'body_after_prefix'
        ? 'body_after_prefix'
        : 'total',
    },
    sessionMemory: {
      autoExtract: typeof sessionMemory.autoExtract === 'boolean'
        ? sessionMemory.autoExtract
        : DEFAULT_PROJECT_MEMORY_SETTINGS.sessionMemory.autoExtract,
      maxOutputTokens: Math.min(Math.max(maxOutputTokens, 1_000), 20_000),
    },
    durableMemory: {
      use: typeof durableMemory.use === 'boolean'
        ? durableMemory.use
        : DEFAULT_PROJECT_MEMORY_SETTINGS.durableMemory.use,
      autoDream: durableMemory.autoDream === true,
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
        ...(typeof memory.compact.enabled === 'boolean' ? { enabled: memory.compact.enabled } : {}),
        ...(positiveInteger(memory.compact.autoCompactTokenLimit, 0)
          ? { autoCompactTokenLimit: positiveInteger(memory.compact.autoCompactTokenLimit, 0) }
          : {}),
        ...(memory.compact.autoCompactTokenLimitScope === 'total'
          || memory.compact.autoCompactTokenLimitScope === 'body_after_prefix'
          ? { autoCompactTokenLimitScope: memory.compact.autoCompactTokenLimitScope }
          : {}),
      };
    }
    if (isRecord(memory.sessionMemory)) {
      patch.sessionMemory = {
        ...(typeof memory.sessionMemory.autoExtract === 'boolean'
          ? { autoExtract: memory.sessionMemory.autoExtract }
          : {}),
        ...(positiveInteger(memory.sessionMemory.maxOutputTokens, 0)
          ? { maxOutputTokens: positiveInteger(memory.sessionMemory.maxOutputTokens, 0) }
          : {}),
      };
    }
    if (isRecord(memory.durableMemory)) {
      const profile = normalizeDreamProfile(memory.durableMemory.dreamExecutionProfile);
      patch.durableMemory = {
        ...(typeof memory.durableMemory.use === 'boolean' ? { use: memory.durableMemory.use } : {}),
        ...(typeof memory.durableMemory.autoDream === 'boolean'
          ? { autoDream: memory.durableMemory.autoDream }
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
  const requestedSessionLimit = memoryPatch.sessionMemory?.maxOutputTokens;
  if (
    requestedSessionLimit !== undefined
    && (!Number.isInteger(requestedSessionLimit)
      || requestedSessionLimit < 1_000
      || requestedSessionLimit > 20_000)
  ) {
    throw new RangeError('Session Memory maxOutputTokens must be between 1000 and 20000.');
  }
  const memory = normalizeMemorySettings({
    ...current.memory,
    ...memoryPatch,
    compact: { ...current.memory.compact, ...(memoryPatch.compact ?? {}) },
    sessionMemory: { ...current.memory.sessionMemory, ...(memoryPatch.sessionMemory ?? {}) },
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
