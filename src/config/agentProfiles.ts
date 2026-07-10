import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ModelApi, ActoviqPermissionMode, ActoviqRunEffort } from '../types.js';
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
  /** Preferred effort for this agent; omit to keep session/default effort. */
  effort?: ActoviqRunEffort;
  /** Optional sampling override for this agent. */
  maxTokens?: number;
  /** Optional sampling override for this agent (0–2). */
  temperature?: number;
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
const VALID_EFFORTS = new Set<ActoviqRunEffort>(['auto', 'low', 'medium', 'high', 'max']);

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

function parseEffort(value: unknown): ActoviqRunEffort | undefined {
  return typeof value === 'string' && VALID_EFFORTS.has(value as ActoviqRunEffort)
    ? (value as ActoviqRunEffort)
    : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function parseTemperature(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) return parsed;
  }
  return undefined;
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
  const effort = parseEffort(raw.effort);
  if (effort) profile.effort = effort;
  const maxTokens = parsePositiveInt(raw.maxTokens);
  if (maxTokens !== undefined) profile.maxTokens = maxTokens;
  const temperature = parseTemperature(raw.temperature);
  if (temperature !== undefined) profile.temperature = temperature;
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

async function resolveValidatedProfileRun(
  validation: AgentProfileValidationResult,
): Promise<ResolvedAgentProfileRun> {
  const config = validation.bridgeConfig;
  const hadamardUsesDefaults = config.runtime === 'hadamard'
    && !(typeof config.apiKey === 'string' && config.apiKey.trim())
    && !(typeof config.baseURL === 'string' && config.baseURL.trim());
  if (hadamardUsesDefaults) {
    return { ...validation, model: validation.profile.model };
  }
  const routed = await buildRouteModelApi({
    model: validation.profile.model,
    provider: config.provider,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxTokens: 32000,
  });
  return { ...validation, model: routed.model, modelApi: routed.modelApi };
}

export async function resolveAgentProfileRun(name: string, homeDir?: string): Promise<ResolvedAgentProfileRun> {
  const profile = findAgentProfile(name, homeDir);
  if (!profile) throw new Error(`Agent profile not found: ${name}`);
  return resolveValidatedProfileRun(validateAgentProfile(profile, homeDir));
}

/** Resolve a composer/issue-selectable agent (saved profile or auto config preset). */
export async function resolveSelectableAgentRun(
  name: string,
  homeDir?: string,
): Promise<ResolvedAgentProfileRun & { selectable: SelectableAgent }> {
  const selectable = findSelectableAgent(name, homeDir);
  if (!selectable) throw new Error(`Agent not found: ${name}`);
  if (selectable.source === 'profile') {
    const resolved = await resolveAgentProfileRun(selectable.name, homeDir);
    return { ...resolved, selectable };
  }
  const synthetic: AgentProfile = {
    name: selectable.name,
    bridgeConfig: selectable.bridgeConfig,
    model: selectable.model,
    ...(selectable.description ? { description: selectable.description } : {}),
  };
  const resolved = await resolveValidatedProfileRun(validateAgentProfile(synthetic, homeDir));
  return { ...resolved, selectable };
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

/** Composer / issue-dispatch selectable entry: explicit profile or auto preset. */
export interface SelectableAgent {
  name: string;
  bridgeConfig: string;
  model: string;
  /** `profile` = saved Agent Profile; `config` = auto preset from a provider config model. */
  source: 'profile' | 'config';
  description?: string;
  permissionMode?: ActoviqPermissionMode;
  systemPromptAppend?: string;
  effort?: ActoviqRunEffort;
  maxTokens?: number;
  temperature?: number;
  /** True when this entry was synthesized and is not stored in agent-configs.json. */
  ephemeral?: boolean;
}

/** Sampling / effort overrides to pass into `session.stream` / `AgentRunOptions`. */
export function agentProfileRunOverrides(profile: Pick<AgentProfile, 'effort' | 'maxTokens' | 'temperature'> | null | undefined): {
  effort?: ActoviqRunEffort;
  maxTokens?: number;
  temperature?: number;
} {
  if (!profile) return {};
  return {
    ...(profile.effort ? { effort: profile.effort } : {}),
    ...(typeof profile.maxTokens === 'number' ? { maxTokens: profile.maxTokens } : {}),
    ...(typeof profile.temperature === 'number' ? { temperature: profile.temperature } : {}),
  };
}

function sanitizeAgentToken(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'agent';
}

function ensureUniqueAgentName(base: string, used: Set<string>): string {
  let candidate = sanitizeAgentToken(base).replace(/^[^A-Za-z0-9]+/, 'a') || 'agent';
  if (!VALID_PROFILE_NAME.test(candidate)) {
    candidate = `a${candidate}`.slice(0, 64);
  }
  if (!used.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const next = `${candidate.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!used.has(next)) return next;
  }
  return `${candidate.slice(0, 58)}-${Date.now().toString(36)}`;
}

/**
 * Agents the UI can pick: saved profiles first, then one auto preset per
 * (provider config, model) that is not already covered by a saved profile.
 */
export function listSelectableAgents(homeDir?: string): SelectableAgent[] {
  const profiles = listAgentProfiles(homeDir);
  const configs = readBridgeConfigs(homeDir).configs;
  const usedNames = new Set<string>();
  const covered = new Set<string>();
  const out: SelectableAgent[] = [];

  for (const profile of profiles) {
    usedNames.add(profile.name);
    covered.add(`${profile.bridgeConfig}\0${profile.model}`);
    out.push({
      name: profile.name,
      bridgeConfig: profile.bridgeConfig,
      model: profile.model,
      source: 'profile',
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.permissionMode ? { permissionMode: profile.permissionMode } : {}),
      ...(profile.systemPromptAppend ? { systemPromptAppend: profile.systemPromptAppend } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      ...(typeof profile.maxTokens === 'number' ? { maxTokens: profile.maxTokens } : {}),
      ...(typeof profile.temperature === 'number' ? { temperature: profile.temperature } : {}),
    });
  }

  for (const config of configs) {
    const models = listAgentProfileBridgeModels(config.name, homeDir);
    if (models.length === 0) continue;
    for (const model of models) {
      const key = `${config.name}\0${model}`;
      if (covered.has(key)) continue;
      covered.add(key);
      const baseName = models.length === 1 ? config.name : `${config.name}.${sanitizeAgentToken(model)}`;
      const name = ensureUniqueAgentName(baseName, usedNames);
      usedNames.add(name);
      out.push({
        name,
        bridgeConfig: config.name,
        model,
        source: 'config',
        ephemeral: true,
        description: `${config.name} · ${model}`,
      });
    }
  }

  return out;
}

export function findSelectableAgent(
  name: string,
  homeDir?: string,
): SelectableAgent | undefined {
  const needle = name.trim();
  if (!needle) return undefined;
  return listSelectableAgents(homeDir).find(agent => agent.name === needle);
}

export function matchSelectableAgent(
  bridgeConfig: string | null | undefined,
  model: string | null | undefined,
  homeDir?: string,
): SelectableAgent | undefined {
  if (!bridgeConfig) return undefined;
  const agents = listSelectableAgents(homeDir);
  const exact = agents.find(
    agent => agent.bridgeConfig === bridgeConfig && (!model || agent.model === model),
  );
  if (exact) return exact;
  return agents.find(agent => agent.bridgeConfig === bridgeConfig);
}

