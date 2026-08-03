import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';

export type ProjectWorkMode = 'coding' | 'daily';

export type ProjectSettings = {
  workMode: ProjectWorkMode;
  customPrompt: string;
  projectRules: string;
  updatedAt?: string;
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  workMode: 'coding',
  customPrompt: '',
  projectRules: '',
};

export function isProjectWorkMode(value: unknown): value is ProjectWorkMode {
  return value === 'coding' || value === 'daily';
}

export function projectSettingsPath(workDir: string, homeDir: string): string {
  return path.join(getHadamardProjectSessionDirectory(workDir, homeDir), 'project-settings.json');
}

function normalizeProjectSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROJECT_SETTINGS };
  const source = raw as Partial<ProjectSettings>;
  return {
    workMode: isProjectWorkMode(source.workMode) ? source.workMode : DEFAULT_PROJECT_SETTINGS.workMode,
    customPrompt: typeof source.customPrompt === 'string' ? source.customPrompt : '',
    projectRules: typeof source.projectRules === 'string' ? source.projectRules : '',
    ...(typeof source.updatedAt === 'string' ? { updatedAt: source.updatedAt } : {}),
  };
}

export async function readProjectSettings(workDir: string, homeDir: string): Promise<ProjectSettings> {
  try {
    const raw = JSON.parse(await readFile(projectSettingsPath(workDir, homeDir), 'utf8')) as unknown;
    return normalizeProjectSettings(raw);
  } catch {
    return { ...DEFAULT_PROJECT_SETTINGS };
  }
}

export async function writeProjectSettings(
  workDir: string,
  homeDir: string,
  patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const current = await readProjectSettings(workDir, homeDir);
  const next: ProjectSettings = {
    workMode: isProjectWorkMode(patch.workMode) ? patch.workMode : current.workMode,
    customPrompt: typeof patch.customPrompt === 'string' ? patch.customPrompt : current.customPrompt,
    projectRules: typeof patch.projectRules === 'string' ? patch.projectRules : current.projectRules,
    updatedAt: new Date().toISOString(),
  };
  const filePath = projectSettingsPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** Pure helper used by GUI prompt builder and unit tests. */
export function appendProjectSettingsToPrompt(base: string, settings: ProjectSettings): string {
  let out = base;
  const custom = settings.customPrompt.trim();
  if (custom) {
    out += `\n\n# Custom instructions\n\n${custom}`;
  }
  const rules = settings.projectRules.trim();
  if (rules) {
    out += `\n\n# Project rules\n\n${rules}`;
  }
  return out;
}
