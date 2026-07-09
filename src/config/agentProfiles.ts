import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ModelApi, ActoviqPermissionMode } from '../types.js';
import { buildRouteModelApi } from '../router/modelRouter.js';
import {
  findBridgeConfig,
  readBridgeConfigs,
  type PersistedBridgeConfig,
} from '../parity/bridgeConfigs.js';
import { resolveActoviqHome } from './actoviqHome.js';

export interface AgentProfile {
  name: string;
  description?: string;
  bridgeConfig: string;
  model: string;
  systemPromptAppend?: string;
  permissionMode?: ActoviqPermissionMode;
}

export interface PersistedAgentProfiles {
  version: 1;
  profiles: AgentProfile[];
}

export interface AgentProfileValidationResult {
  profile: AgentProfile;
  bridgeConfig: PersistedBridgeConfig;
  warnings: string[];
}

export interface ResolvedAgentProfileRun extends AgentProfileValidationResult {
  model: string;
  modelApi?: ModelApi;
}

const VALID_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALID_PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
]);

export function getAgentProfilesPath(homeDir?: string): string {
  return path.join(resolveActoviqHome(homeDir), 'agent-configs.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePermissionMode(value: unknown): ActoviqPermissionMode | undefined {
  return typeof value === 'string' && VALID_PERMISSION_MODES.has(value as ActoviqPermissionMode)
    ? (value as ActoviqPermissionMode)
    : undefined;
}

function normalizeAgentProfile(raw: unknown): AgentProfile | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const bridgeConfig = typeof raw.bridgeConfig === 'string' ? raw.bridgeConfig.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!name || !bridgeConfig || !model) return null;
  const profile: AgentProfile = { name, bridgeConfig, model };
  if (typeof raw.description === 'string' && raw.description.trim()) {
    profile.description = raw.description.trim();
  }
  if (typeof raw.systemPromptAppend === 'string' && raw.systemPromptAppend.trim()) {
    profile.systemPromptAppend = raw.systemPromptAppend.trim();
  }
  const permissionMode = parsePermissionMode(raw.permissionMode);
  if (permissionMode) profile.permissionMode = permissionMode;
  return profile;
}

function assertValidAgentProfile(profile: AgentProfile): void {
  if (!VALID_PROFILE_NAME.test(profile.name)) {
    throw new Error('Invalid profile name (use letters, digits, . _ -)');
  }
  if (!profile.bridgeConfig.trim()) {
    throw new Error('Missing bridge config');
  }
  if (!profile.model.trim()) {
    throw new Error('Missing model');
  }
}

export function readAgentProfiles(homeDir?: string): PersistedAgentProfiles {
  const file = getAgentProfilesPath(homeDir);
  if (!existsSync(file)) return { version: 1, profiles: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.map(normalizeAgentProfile).filter((profile: AgentProfile | null): profile is AgentProfile => Boolean(profile))
      : [];
    return { version: 1, profiles };
  } catch {
    return { version: 1, profiles: [] };
  }
}

export function writeAgentProfiles(store: PersistedAgentProfiles, homeDir?: string): void {
  const file = getAgentProfilesPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const profiles = store.profiles.map((profile) => {
    assertValidAgentProfile(profile);
    return normalizeAgentProfile(profile)!;
  });
  writeFileSync(file, JSON.stringify({ version: 1, profiles }, null, 2), 'utf-8');
}

export function listAgentProfiles(homeDir?: string): AgentProfile[] {
  return readAgentProfiles(homeDir).profiles;
}

export function findAgentProfile(name: string, homeDir?: string): AgentProfile | undefined {
  return readAgentProfiles(homeDir).profiles.find(profile => profile.name === name);
}

export function validateAgentProfile(profile: AgentProfile, homeDir?: string): AgentProfileValidationResult {
  assertValidAgentProfile(profile);
  const bridgeConfig = findBridgeConfig(profile.bridgeConfig, homeDir);
  if (!bridgeConfig) {
    throw new Error(`Bridge config not found: ${profile.bridgeConfig}`);
  }
  const warnings: string[] = [];
  const models = Array.isArray(bridgeConfig.models) ? bridgeConfig.models : [];
  if (models.length > 0 && !models.some(model => model.name === profile.model)) {
    warnings.push(`Model "${profile.model}" is not registered on bridge config "${bridgeConfig.name}".`);
  }
  if (models.length === 0 && (!bridgeConfig.model || bridgeConfig.model !== profile.model)) {
    warnings.push(`Bridge config "${bridgeConfig.name}" has no registered models; saving custom model "${profile.model}".`);
  }
  return { profile, bridgeConfig, warnings };
}

export function upsertAgentProfile(profile: AgentProfile, homeDir?: string): {
  store: PersistedAgentProfiles;
  profile: AgentProfile;
  warnings: string[];
} {
  const normalized = normalizeAgentProfile(profile);
  if (!normalized) throw new Error('Missing profile fields');
  const validation = validateAgentProfile(normalized, homeDir);
  const current = readAgentProfiles(homeDir);
  const nextProfiles = current.profiles.filter(existing => existing.name !== normalized.name);
  nextProfiles.push(normalized);
  const store = { version: 1 as const, profiles: nextProfiles };
  writeAgentProfiles(store, homeDir);
  return { store, profile: validation.profile, warnings: validation.warnings };
}

export function deleteAgentProfile(name: string, homeDir?: string): PersistedAgentProfiles {
  const current = readAgentProfiles(homeDir);
  const next = {
    version: 1 as const,
    profiles: current.profiles.filter(profile => profile.name !== name),
  };
  writeAgentProfiles(next, homeDir);
  if (next.profiles.length === 0) {
    const file = getAgentProfilesPath(homeDir);
    try { unlinkSync(file); } catch { /* ignore */ }
  }
  return next;
}

export async function resolveAgentProfileRun(name: string, homeDir?: string): Promise<ResolvedAgentProfileRun> {
  const profile = findAgentProfile(name, homeDir);
  if (!profile) throw new Error(`Agent profile not found: ${name}`);
  const validation = validateAgentProfile(profile, homeDir);
  const config = validation.bridgeConfig;
  const hadamardUsesDefaults = config.runtime === 'hadamard'
    && !(typeof config.apiKey === 'string' && config.apiKey.trim())
    && !(typeof config.baseURL === 'string' && config.baseURL.trim());
  if (hadamardUsesDefaults) {
    return { ...validation, model: profile.model };
  }
  const routed = await buildRouteModelApi({
    model: profile.model,
    provider: config.provider,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxTokens: 32000,
  });
  return { ...validation, model: routed.model, modelApi: routed.modelApi };
}

export function listAgentProfileBridgeModels(bridgeConfigName: string, homeDir?: string): string[] {
  const config = readBridgeConfigs(homeDir).configs.find(item => item.name === bridgeConfigName);
  if (!config) return [];
  const models = new Set<string>();
  if (config.model) models.add(config.model);
  for (const model of config.models ?? []) {
    if (model.name) models.add(model.name);
  }
  return [...models];
}
