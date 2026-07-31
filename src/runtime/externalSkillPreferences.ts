import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { HadamardExternalSkillsOptions } from '../types.js';
import { isRecord } from './helpers.js';

export interface HadamardExternalSkillPreferences {
  enabledSourceIds?: string[];
  disabledSourceIds: string[];
  disabledSkillIds: string[];
  trustedProjectSourceIds: string[];
  preferredSkillIds: Record<string, string>;
}

interface StoredExternalSkillPreferences {
  version: 1;
  workspaces: Record<string, HadamardExternalSkillPreferences>;
}

export interface HadamardExternalSkillPreferenceLocation {
  hadamardHomeDir: string;
  workDir: string;
}

const PREFERENCES_FILE = 'skill-preferences.json';

/** Project-scoped trust prevents approving a native project skill globally. */
export async function readHadamardExternalSkillPreferences(
  location: HadamardExternalSkillPreferenceLocation,
): Promise<HadamardExternalSkillPreferences> {
  const stored = await readStore(location.hadamardHomeDir);
  return normalizePreferences(stored.workspaces[workspaceKey(location.workDir)]);
}

/** Writes only Hadamard-owned state; native CLI skill directories stay read-only. */
export async function writeHadamardExternalSkillPreferences(
  location: HadamardExternalSkillPreferenceLocation,
  preferences: Partial<HadamardExternalSkillPreferences>,
): Promise<HadamardExternalSkillPreferences> {
  const stored = await readStore(location.hadamardHomeDir);
  const normalized = normalizePreferences(preferences);
  stored.workspaces[workspaceKey(location.workDir)] = normalized;
  const filePath = hadamardExternalSkillPreferencesPath(location.hadamardHomeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return normalized;
}

/** Disable one catalog variant without changing its source or native files. */
export async function setHadamardExternalSkillDisabled(
  location: HadamardExternalSkillPreferenceLocation,
  skillId: string,
  disabled: boolean,
): Promise<HadamardExternalSkillPreferences> {
  const normalizedSkillId = normalizeRequiredValue(skillId, 'skillId');
  return updateWorkspacePreferences(location, current => {
    const disabledSkillIds = new Set(current.disabledSkillIds);
    if (disabled) disabledSkillIds.add(normalizedSkillId);
    else disabledSkillIds.delete(normalizedSkillId);
    return { ...current, disabledSkillIds: [...disabledSkillIds] };
  });
}

/** Select one catalog variant for an invocation-name conflict. */
export async function setHadamardPreferredExternalSkill(
  location: HadamardExternalSkillPreferenceLocation,
  invocationName: string,
  skillId: string,
): Promise<HadamardExternalSkillPreferences> {
  const name = normalizeRequiredValue(invocationName, 'invocationName');
  const normalizedSkillId = normalizeRequiredValue(skillId, 'skillId');
  return updateWorkspacePreferences(location, current => ({
    ...current,
    preferredSkillIds: { ...current.preferredSkillIds, [name]: normalizedSkillId },
  }));
}

/** Clear a previous conflict choice so resolution returns to fail-closed mode. */
export async function clearHadamardPreferredExternalSkill(
  location: HadamardExternalSkillPreferenceLocation,
  invocationName: string,
): Promise<HadamardExternalSkillPreferences> {
  const name = normalizeRequiredValue(invocationName, 'invocationName');
  return updateWorkspacePreferences(location, current => {
    const preferredSkillIds = { ...current.preferredSkillIds };
    delete preferredSkillIds[name];
    return { ...current, preferredSkillIds };
  });
}

export function hadamardExternalSkillPreferencesPath(hadamardHomeDir: string): string {
  return path.join(path.resolve(hadamardHomeDir), PREFERENCES_FILE);
}

export function externalSkillPreferencesToRuntimeOptions(
  preferences: HadamardExternalSkillPreferences,
): HadamardExternalSkillsOptions {
  return {
    ...(preferences.enabledSourceIds
      ? { enabledSourceIds: [...preferences.enabledSourceIds] }
      : {}),
    disabledSourceIds: [...preferences.disabledSourceIds],
    disabledSkillIds: [...(preferences.disabledSkillIds ?? [])],
    trustedProjectSourceIds: [...preferences.trustedProjectSourceIds],
    preferredSkillIds: { ...preferences.preferredSkillIds },
  };
}

async function readStore(hadamardHomeDir: string): Promise<StoredExternalSkillPreferences> {
  try {
    const parsed = JSON.parse(
      await readFile(hadamardExternalSkillPreferencesPath(hadamardHomeDir), 'utf8'),
    ) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.workspaces)) return emptyStore();
    const workspaces: Record<string, HadamardExternalSkillPreferences> = {};
    for (const [key, value] of Object.entries(parsed.workspaces)) {
      if (!isRecord(value)) continue;
      workspaces[key] = normalizePreferences(value);
    }
    return { version: 1, workspaces };
  } catch {
    return emptyStore();
  }
}

function emptyStore(): StoredExternalSkillPreferences {
  return { version: 1, workspaces: {} };
}

function normalizePreferences(value: unknown): HadamardExternalSkillPreferences {
  const record = isRecord(value) ? value : {};
  const enabledSourceIds = normalizeStringArray(record.enabledSourceIds);
  return {
    ...(Array.isArray(record.enabledSourceIds) ? { enabledSourceIds } : {}),
    disabledSourceIds: normalizeStringArray(record.disabledSourceIds),
    disabledSkillIds: normalizeStringArray(record.disabledSkillIds),
    trustedProjectSourceIds: normalizeStringArray(record.trustedProjectSourceIds),
    preferredSkillIds: normalizeStringRecord(record.preferredSkillIds),
  };
}

async function updateWorkspacePreferences(
  location: HadamardExternalSkillPreferenceLocation,
  update: (
    current: HadamardExternalSkillPreferences,
  ) => Partial<HadamardExternalSkillPreferences>,
): Promise<HadamardExternalSkillPreferences> {
  const stored = await readStore(location.hadamardHomeDir);
  const key = workspaceKey(location.workDir);
  const normalized = normalizePreferences(update(normalizePreferences(stored.workspaces[key])));
  stored.workspaces[key] = normalized;
  const filePath = hadamardExternalSkillPreferencesPath(location.hadamardHomeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeRequiredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] =>
      entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1].trim().length > 0,
    )
    .map(([key, entry]) => [key.trim(), entry.trim()] as [string, string])
    .sort((left, right) => left[0].localeCompare(right[0])));
}

function workspaceKey(workDir: string): string {
  const resolved = path.resolve(workDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
