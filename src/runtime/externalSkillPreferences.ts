import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActoviqExternalSkillsOptions } from '../types.js';
import { isRecord } from './helpers.js';

export interface ActoviqExternalSkillPreferences {
  enabledSourceIds?: string[];
  disabledSourceIds: string[];
  disabledSkillIds: string[];
  trustedProjectSourceIds: string[];
  preferredSkillIds: Record<string, string>;
}

interface StoredExternalSkillPreferences {
  version: 1;
  workspaces: Record<string, ActoviqExternalSkillPreferences>;
}

export interface ActoviqExternalSkillPreferenceLocation {
  actoviqHomeDir: string;
  workDir: string;
}

const PREFERENCES_FILE = 'skill-preferences.json';

/** Project-scoped trust prevents approving a native project skill globally. */
export async function readActoviqExternalSkillPreferences(
  location: ActoviqExternalSkillPreferenceLocation,
): Promise<ActoviqExternalSkillPreferences> {
  const stored = await readStore(location.actoviqHomeDir);
  return normalizePreferences(stored.workspaces[workspaceKey(location.workDir)]);
}

/** Writes only Actoviq-owned state; native CLI skill directories stay read-only. */
export async function writeActoviqExternalSkillPreferences(
  location: ActoviqExternalSkillPreferenceLocation,
  preferences: Partial<ActoviqExternalSkillPreferences>,
): Promise<ActoviqExternalSkillPreferences> {
  const stored = await readStore(location.actoviqHomeDir);
  const normalized = normalizePreferences(preferences);
  stored.workspaces[workspaceKey(location.workDir)] = normalized;
  const filePath = actoviqExternalSkillPreferencesPath(location.actoviqHomeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return normalized;
}

/** Disable one catalog variant without changing its source or native files. */
export async function setActoviqExternalSkillDisabled(
  location: ActoviqExternalSkillPreferenceLocation,
  skillId: string,
  disabled: boolean,
): Promise<ActoviqExternalSkillPreferences> {
  const normalizedSkillId = normalizeRequiredValue(skillId, 'skillId');
  return updateWorkspacePreferences(location, current => {
    const disabledSkillIds = new Set(current.disabledSkillIds);
    if (disabled) disabledSkillIds.add(normalizedSkillId);
    else disabledSkillIds.delete(normalizedSkillId);
    return { ...current, disabledSkillIds: [...disabledSkillIds] };
  });
}

/** Select one catalog variant for an invocation-name conflict. */
export async function setActoviqPreferredExternalSkill(
  location: ActoviqExternalSkillPreferenceLocation,
  invocationName: string,
  skillId: string,
): Promise<ActoviqExternalSkillPreferences> {
  const name = normalizeRequiredValue(invocationName, 'invocationName');
  const normalizedSkillId = normalizeRequiredValue(skillId, 'skillId');
  return updateWorkspacePreferences(location, current => ({
    ...current,
    preferredSkillIds: { ...current.preferredSkillIds, [name]: normalizedSkillId },
  }));
}

/** Clear a previous conflict choice so resolution returns to fail-closed mode. */
export async function clearActoviqPreferredExternalSkill(
  location: ActoviqExternalSkillPreferenceLocation,
  invocationName: string,
): Promise<ActoviqExternalSkillPreferences> {
  const name = normalizeRequiredValue(invocationName, 'invocationName');
  return updateWorkspacePreferences(location, current => {
    const preferredSkillIds = { ...current.preferredSkillIds };
    delete preferredSkillIds[name];
    return { ...current, preferredSkillIds };
  });
}

export function actoviqExternalSkillPreferencesPath(actoviqHomeDir: string): string {
  return path.join(path.resolve(actoviqHomeDir), PREFERENCES_FILE);
}

export function externalSkillPreferencesToRuntimeOptions(
  preferences: ActoviqExternalSkillPreferences,
): ActoviqExternalSkillsOptions {
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

async function readStore(actoviqHomeDir: string): Promise<StoredExternalSkillPreferences> {
  try {
    const parsed = JSON.parse(
      await readFile(actoviqExternalSkillPreferencesPath(actoviqHomeDir), 'utf8'),
    ) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.workspaces)) return emptyStore();
    const workspaces: Record<string, ActoviqExternalSkillPreferences> = {};
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

function normalizePreferences(value: unknown): ActoviqExternalSkillPreferences {
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
  location: ActoviqExternalSkillPreferenceLocation,
  update: (
    current: ActoviqExternalSkillPreferences,
  ) => Partial<ActoviqExternalSkillPreferences>,
): Promise<ActoviqExternalSkillPreferences> {
  const stored = await readStore(location.actoviqHomeDir);
  const key = workspaceKey(location.workDir);
  const normalized = normalizePreferences(update(normalizePreferences(stored.workspaces[key])));
  stored.workspaces[key] = normalized;
  const filePath = actoviqExternalSkillPreferencesPath(location.actoviqHomeDir);
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
