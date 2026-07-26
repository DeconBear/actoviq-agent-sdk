import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveActoviqHome } from '../config/actoviqHome.js';
import { getDefaultActoviqBundledSkills } from './actoviqSkills.js';

export type ActoviqSkillCatalogProvider =
  | 'actoviq'
  | 'agents'
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'cc-switch';

export type ActoviqSkillCatalogScope = 'bundled' | 'user' | 'project';

export type ActoviqSkillCatalogSourceStatus =
  | 'ready'
  | 'needs-trust'
  | 'missing'
  | 'unreadable';

export type ActoviqSkillCatalogEntryStatus = 'ready' | 'needs-trust' | 'invalid';

export type ActoviqSkillCatalogCapability = 'assets' | 'references' | 'scripts';

export interface ActoviqSkillCatalogDiagnostic {
  code:
    | 'invalid-frontmatter'
    | 'invalid-name'
    | 'missing-skill-file'
    | 'skill-too-large'
    | 'source-unreadable'
    | 'skill-unreadable';
  severity: 'warning' | 'error';
  sourceId: string;
  message: string;
  path?: string;
}

export interface ActoviqSkillCatalogSource {
  id: string;
  label: string;
  provider: ActoviqSkillCatalogProvider;
  scope: ActoviqSkillCatalogScope;
  root?: string;
  managedBy: string;
  readOnly: boolean;
  needsTrust: boolean;
  status: ActoviqSkillCatalogSourceStatus;
  skillCount: number;
}

export interface ActoviqSkillCatalogOrigin {
  sourceId: string;
  sourceLabel: string;
  provider: ActoviqSkillCatalogProvider;
  scope: ActoviqSkillCatalogScope;
  directoryName: string;
  loadedFrom: 'bundled' | 'skills' | 'commands';
  skillRoot?: string;
  canonicalSkillRoot?: string;
  skillFile?: string;
  canonicalSkillFile?: string;
  readOnly: boolean;
  needsTrust: boolean;
}

export interface ActoviqSkillCatalogEntry {
  /** Stable source identity. Content revisions are tracked separately by contentHash. */
  id: string;
  /** The invocation name. A valid frontmatter `name` wins over the directory name. */
  name: string;
  aliases: string[];
  directoryName: string;
  description: string;
  version?: string;
  status: ActoviqSkillCatalogEntryStatus;
  conflict: boolean;
  contentHash: string;
  sourceId: string;
  provider: ActoviqSkillCatalogProvider;
  scope: ActoviqSkillCatalogScope;
  skillRoot?: string;
  canonicalSkillRoot?: string;
  readOnly: boolean;
  needsTrust: boolean;
  capabilities: ActoviqSkillCatalogCapability[];
  /** Metadata only. The catalog never turns declarations into permission grants. */
  declaredAllowedTools: string[];
  frontmatterKeys: string[];
  origins: ActoviqSkillCatalogOrigin[];
  diagnostics: ActoviqSkillCatalogDiagnostic[];
}

export interface ActoviqSkillCatalogConflict {
  name: string;
  skillIds: string[];
  contentHashes: string[];
  sourceIds: string[];
}

export interface ActoviqSkillCatalog {
  generatedAt: string;
  sources: ActoviqSkillCatalogSource[];
  skills: ActoviqSkillCatalogEntry[];
  conflicts: ActoviqSkillCatalogConflict[];
  diagnostics: ActoviqSkillCatalogDiagnostic[];
  summary: {
    sourceCount: number;
    discoveredSourceCount: number;
    skillVariantCount: number;
    invocationCount: number;
    conflictCount: number;
    diagnosticCount: number;
  };
}

export interface DiscoverActoviqSkillCatalogOptions {
  /** Operating-system home used for native CLI roots. Defaults to os.homedir(). */
  osHomeDir?: string;
  /** Direct Actoviq data root. When omitted ACTOVIQ_HOME/data-root/default resolution is used. */
  actoviqHomeDir?: string;
  /** Project whose native and Actoviq skill roots should be inspected. */
  workDir?: string;
  /** Environment seam for CLAUDE_CONFIG_DIR, CODEX_HOME, and ACTOVIQ_HOME. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  includeBundledActoviq?: boolean;
  includeMissingSources?: boolean;
  trustedProjectSourceIds?: readonly string[];
  maxSkillBytes?: number;
  scanConcurrency?: number;
}

interface SkillSourceDescriptor extends ActoviqSkillCatalogSource {
  order: number;
  kind: 'bundled' | 'directory' | 'commands';
  excludeDirectoryNames: ReadonlySet<string>;
  invocationPrefix?: string;
}

interface ParsedFrontmatter {
  values: Record<string, string>;
  body: string;
  diagnostics: Array<{ code: 'invalid-frontmatter'; message: string }>;
  invalid: boolean;
}

interface SkillCandidate {
  name: string;
  aliases: string[];
  directoryName: string;
  description: string;
  version?: string;
  invalid: boolean;
  contentHash: string;
  capabilities: ActoviqSkillCatalogCapability[];
  declaredAllowedTools: string[];
  frontmatterKeys: string[];
  origins: ActoviqSkillCatalogOrigin[];
  diagnostics: ActoviqSkillCatalogDiagnostic[];
}

const DEFAULT_MAX_SKILL_BYTES = 1024 * 1024;
const DEFAULT_SCAN_CONCURRENCY = 8;
const EMPTY_EXCLUSIONS = new Set<string>();
const CODEX_EXCLUSIONS = new Set(['.system']);

/**
 * Discover a normalized, read-only catalog without changing Actoviq settings or
 * any native runtime directory. The result is intentionally metadata-only so it
 * can be returned directly by GUI/TUI APIs.
 */
export async function discoverActoviqSkillCatalog(
  options: DiscoverActoviqSkillCatalogOptions = {},
): Promise<ActoviqSkillCatalog> {
  const descriptors = await buildSourceDescriptors(options);
  const diagnostics: ActoviqSkillCatalogDiagnostic[] = [];
  const candidates: SkillCandidate[] = [];

  for (const source of descriptors) {
    const discovered = source.kind === 'bundled'
      ? bundledCandidates(source)
      : source.kind === 'commands'
        ? await scanCommandSkillSource(source, options, diagnostics)
        : await scanSkillSource(source, options, diagnostics);
    source.skillCount = discovered.length;
    candidates.push(...discovered);
  }

  const skills = deduplicateCandidates(candidates);
  const conflicts = markConflicts(skills);
  const visibleSources = options.includeMissingSources === false
    ? descriptors.filter(source => source.status !== 'missing')
    : descriptors;

  return {
    generatedAt: new Date().toISOString(),
    sources: visibleSources
      .sort((left, right) => left.order - right.order)
      .map(toPublicSource),
    skills: skills.sort(compareSkills),
    conflicts,
    diagnostics: diagnostics.sort(compareDiagnostics),
    summary: {
      sourceCount: visibleSources.length,
      discoveredSourceCount: visibleSources.filter(source => source.status !== 'missing').length,
      skillVariantCount: skills.length,
      invocationCount: new Set(skills.map(skill => skill.name)).size,
      conflictCount: conflicts.length,
      diagnosticCount: diagnostics.length,
    },
  };
}

async function buildSourceDescriptors(
  options: DiscoverActoviqSkillCatalogOptions,
): Promise<SkillSourceDescriptor[]> {
  const env = options.env ?? process.env;
  const osHomeDir = path.resolve(options.osHomeDir ?? os.homedir());
  const workDir = path.resolve(options.workDir ?? process.cwd());
  const actoviqHomeDir = options.actoviqHomeDir?.trim()
    ? path.resolve(options.actoviqHomeDir)
    : resolveActoviqHome(undefined, { env, osHomeDir });
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim()
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(osHomeDir, '.claude');
  const codexHome = env.CODEX_HOME?.trim()
    ? path.resolve(env.CODEX_HOME)
    : path.join(osHomeDir, '.codex');
  const trustedProjectSources = new Set(options.trustedProjectSourceIds ?? []);
  const sources: SkillSourceDescriptor[] = [];

  const add = (input: Omit<SkillSourceDescriptor, 'needsTrust' | 'order' | 'skillCount' | 'status'>): void => {
    const needsTrust = input.scope === 'project' && !trustedProjectSources.has(input.id);
    sources.push({
      ...input,
      needsTrust,
      order: sources.length,
      skillCount: 0,
      status: input.kind === 'bundled' ? 'ready' : 'missing',
    });
  };

  if (options.includeBundledActoviq !== false) {
    add({
      id: 'actoviq:bundled',
      label: 'Actoviq bundled skills',
      provider: 'actoviq',
      scope: 'bundled',
      managedBy: 'Actoviq',
      readOnly: true,
      kind: 'bundled',
      excludeDirectoryNames: EMPTY_EXCLUSIONS,
    });
  }

  addDirectorySource(add, 'actoviq:user', 'Actoviq user skills', 'actoviq', 'user', path.join(actoviqHomeDir, 'skills'), false);
  addDirectorySource(add, 'actoviq:project', 'Actoviq project skills', 'actoviq', 'project', path.join(workDir, '.actoviq', 'skills'), false);
  addDirectorySource(
    add,
    'actoviq:project-commands',
    'Actoviq project commands',
    'actoviq',
    'project',
    path.join(workDir, '.actoviq', 'commands'),
    false,
    EMPTY_EXCLUSIONS,
    undefined,
    'commands',
  );
  addDirectorySource(add, 'agents:user', 'Shared agent skills', 'agents', 'user', path.join(osHomeDir, '.agents', 'skills'), true);
  addDirectorySource(add, 'agents:project', 'Project shared agent skills', 'agents', 'project', path.join(workDir, '.agents', 'skills'), true);
  addDirectorySource(add, 'claude-code:user', 'Claude Code user skills', 'claude-code', 'user', path.join(claudeConfigDir, 'skills'), true);
  addDirectorySource(add, 'claude-code:project', 'Claude Code project skills', 'claude-code', 'project', path.join(workDir, '.claude', 'skills'), true);
  addDirectorySource(add, 'codex:user', 'Codex user skills', 'codex', 'user', path.join(codexHome, 'skills'), true, CODEX_EXCLUSIONS);
  addDirectorySource(add, 'codex:project', 'Codex project skills', 'codex', 'project', path.join(workDir, '.codex', 'skills'), true, CODEX_EXCLUSIONS);
  addDirectorySource(add, 'cursor:user', 'Cursor user skills', 'cursor', 'user', path.join(osHomeDir, '.cursor', 'skills'), true);
  addDirectorySource(add, 'cursor:project', 'Cursor project skills', 'cursor', 'project', path.join(workDir, '.cursor', 'skills'), true);
  addDirectorySource(add, 'cc-switch:user', 'cc-switch user skills', 'cc-switch', 'user', path.join(osHomeDir, '.cc-switch', 'skills'), true);
  addDirectorySource(add, 'cc-switch:project', 'cc-switch project skills', 'cc-switch', 'project', path.join(workDir, '.cc-switch', 'skills'), true);

  await addClaudePluginSources(add, claudeConfigDir, workDir);
  await addCodexPluginSources(add, codexHome);

  return sources;
}

function addDirectorySource(
  add: (input: Omit<SkillSourceDescriptor, 'needsTrust' | 'order' | 'skillCount' | 'status'>) => void,
  id: string,
  label: string,
  provider: ActoviqSkillCatalogProvider,
  scope: Exclude<ActoviqSkillCatalogScope, 'bundled'>,
  root: string,
  readOnly: boolean,
  excludeDirectoryNames: ReadonlySet<string> = EMPTY_EXCLUSIONS,
  invocationPrefix?: string,
  kind: Extract<SkillSourceDescriptor['kind'], 'directory' | 'commands'> = 'directory',
): void {
  add({
    id,
    label,
    provider,
    scope,
    root: path.resolve(root),
    managedBy: providerLabel(provider),
    readOnly,
    kind,
    excludeDirectoryNames,
    ...(invocationPrefix ? { invocationPrefix } : {}),
  });
}

async function addClaudePluginSources(
  add: (input: Omit<SkillSourceDescriptor, 'needsTrust' | 'order' | 'skillCount' | 'status'>) => void,
  claudeConfigDir: string,
  workDir: string,
): Promise<void> {
  const installed = await readJsonRecord(path.join(
    claudeConfigDir,
    'plugins',
    'installed_plugins.json',
  ));
  const enabledPlugins = await readEffectiveClaudePluginActivations(claudeConfigDir, workDir);
  const installedPlugins = asRecord(installed?.plugins);
  if (!installedPlugins) return;

  for (const [pluginId, activation] of [...enabledPlugins].sort(([left], [right]) => left.localeCompare(right))) {
    if (!activation.enabled) continue;
    const parsedId = parsePluginIdentifier(pluginId);
    if (!parsedId) continue;
    const rawEntries = installedPlugins[pluginId];
    const entries = (Array.isArray(rawEntries) ? rawEntries : [rawEntries])
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter(entry => typeof entry.installPath === 'string' && entry.installPath.trim());
    const installation = selectClaudePluginInstallation(
      entries,
      activation.scope,
      claudeConfigDir,
      workDir,
    );
    if (!installation) continue;
    const scope: Exclude<ActoviqSkillCatalogScope, 'bundled'> =
      activation.scope === 'project' || activation.scope === 'local' ? 'project' : 'user';
    addDirectorySource(
      add,
      `claude-code:plugin:${pluginId}`,
      `${parsedId.pluginName} (${parsedId.marketplaceName}) Claude Code plugin skills`,
      'claude-code',
      scope,
      path.join(installation.path, 'skills'),
      true,
      EMPTY_EXCLUSIONS,
      parsedId.pluginName,
    );
  }
}

type ClaudePluginActivationScope = 'user' | 'project' | 'local';

interface ClaudePluginActivation {
  enabled: boolean;
  scope: ClaudePluginActivationScope;
}

async function readEffectiveClaudePluginActivations(
  claudeConfigDir: string,
  workDir: string,
): Promise<Map<string, ClaudePluginActivation>> {
  const layers: Array<{ scope: ClaudePluginActivationScope; file: string }> = [
    { scope: 'user', file: path.join(claudeConfigDir, 'settings.json') },
    { scope: 'project', file: path.join(workDir, '.claude', 'settings.json') },
    { scope: 'local', file: path.join(workDir, '.claude', 'settings.local.json') },
  ];
  const activations = new Map<string, ClaudePluginActivation>();
  for (const layer of layers) {
    const settings = await readJsonRecord(layer.file);
    const configured = asRecord(settings?.enabledPlugins);
    if (!configured) continue;
    for (const [pluginId, value] of Object.entries(configured)) {
      if (typeof value !== 'boolean') continue;
      activations.set(pluginId, { enabled: value, scope: layer.scope });
    }
  }
  return activations;
}

function selectClaudePluginInstallation(
  entries: Record<string, unknown>[],
  activationScope: ClaudePluginActivationScope,
  claudeConfigDir: string,
  workDir: string,
): { path: string; entry: Record<string, unknown> } | undefined {
  const installations = entries.flatMap(entry => {
    const rawInstallPath = (entry.installPath as string).trim();
    const installPath = path.resolve(
      path.isAbsolute(rawInstallPath)
        ? rawInstallPath
        : path.join(claudeConfigDir, 'plugins', rawInstallPath),
    );
    const scope = typeof entry.scope === 'string'
      ? entry.scope.trim().toLowerCase()
      : 'user';
    const declaredProjectPath = ['projectPath', 'projectDir', 'workDir', 'cwd']
      .map(key => entry[key])
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (
      (scope === 'project' || scope === 'local')
      && declaredProjectPath
      && comparablePath(declaredProjectPath) !== comparablePath(workDir)
    ) return [];
    return [{ path: installPath, entry, scope }];
  });

  const scopeGroups = activationScope === 'user'
    ? [['user'], ['managed'], ['project', 'local']]
    : [[activationScope], ['project', 'local'], ['user'], ['managed']];
  for (const scopes of scopeGroups) {
    const installPaths = new Map<string, { path: string; entry: Record<string, unknown> }>();
    for (const installation of installations) {
      if (!scopes.includes(installation.scope)) continue;
      installPaths.set(comparablePath(installation.path), installation);
    }
    if (installPaths.size === 1) return [...installPaths.values()][0];
    if (installPaths.size > 1) return undefined;
  }
  return undefined;
}

async function addCodexPluginSources(
  add: (input: Omit<SkillSourceDescriptor, 'needsTrust' | 'order' | 'skillCount' | 'status'>) => void,
  codexHome: string,
): Promise<void> {
  const configPath = path.join(codexHome, 'config.toml');
  let config: string;
  try {
    config = await readFile(configPath, 'utf8');
  } catch {
    return;
  }
  const parsedConfig = parseCodexPluginConfig(config, path.dirname(configPath));
  for (const pluginId of [...parsedConfig.enabledPluginIds].sort()) {
    const parsedId = parsePluginIdentifier(pluginId);
    if (!parsedId) continue;
    const marketplaceSource = parsedConfig.marketplaceSources.get(parsedId.marketplaceName);
    const marketplacePluginRoot = marketplaceSource
      ? await existingDirectory(path.join(marketplaceSource, 'plugins', parsedId.pluginName))
      : undefined;
    const pluginRoot = marketplacePluginRoot ?? await resolveCodexCachedPluginRoot(
      codexHome,
      parsedId.marketplaceName,
      parsedId.pluginName,
    );
    if (!pluginRoot) continue;
    addDirectorySource(
      add,
      `codex:plugin:${pluginId}`,
      `${parsedId.pluginName} (${parsedId.marketplaceName}) Codex plugin skills`,
      'codex',
      'user',
      path.join(pluginRoot, 'skills'),
      true,
      EMPTY_EXCLUSIONS,
      parsedId.pluginName,
    );
  }
}

async function resolveCodexCachedPluginRoot(
  codexHome: string,
  marketplaceName: string,
  pluginName: string,
): Promise<string | undefined> {
  const exactPluginRoot = path.join(
    codexHome,
    'plugins',
    'cache',
    marketplaceName,
    pluginName,
  );
  let versions: Dirent[];
  try {
    versions = (await readdir(exactPluginRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
  const latest = versions.find(entry => entry.name === 'latest');
  if (latest) return existingDirectory(path.join(exactPluginRoot, latest.name));
  if (versions.length !== 1) return undefined;
  return existingDirectory(path.join(exactPluginRoot, versions[0]!.name));
}

interface ParsedCodexPluginConfig {
  enabledPluginIds: Set<string>;
  marketplaceSources: Map<string, string>;
}

function parseCodexPluginConfig(
  content: string,
  configDir: string,
): ParsedCodexPluginConfig {
  const marketplaceSources = new Map<string, string>();
  const pluginEnabled = new Map<string, boolean>();
  let section: { kind: 'marketplace' | 'plugin'; name: string } | undefined;
  for (const line of content.replace(/\r\n?/gu, '\n').split('\n')) {
    const header = line.match(
      /^\s*\[\s*(marketplaces|plugins)\.(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_.@-]+))\s*\]\s*(?:#.*)?$/u,
    );
    if (header) {
      const name = header[2] !== undefined
        ? parseDoubleQuotedString(`"${header[2]}"`)
        : header[3] !== undefined ? header[3].replace(/''/gu, "'") : header[4];
      section = name
        ? { kind: header[1] === 'marketplaces' ? 'marketplace' : 'plugin', name }
        : undefined;
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      section = undefined;
      continue;
    }
    if (!section) continue;
    if (section.kind === 'marketplace') {
      const sourceMatch = line.match(/^\s*source\s*=\s*(.*?)\s*$/u);
      const source = sourceMatch ? parseTomlString(sourceMatch[1]!) : undefined;
      if (source) {
        marketplaceSources.set(
          section.name,
          path.resolve(path.isAbsolute(source) ? source : path.join(configDir, source)),
        );
      }
      continue;
    }
    const enabledMatch = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u);
    if (enabledMatch) pluginEnabled.set(section.name, enabledMatch[1] === 'true');
  }
  return {
    marketplaceSources,
    enabledPluginIds: new Set(
      [...pluginEnabled].filter(([, enabled]) => enabled).map(([pluginId]) => pluginId),
    ),
  };
}

function parseTomlString(value: string): string | undefined {
  const singleQuoted = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/u);
  if (singleQuoted) return singleQuoted[1]!.replace(/''/gu, "'");
  const doubleQuoted = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u);
  return doubleQuoted ? parseDoubleQuotedString(doubleQuoted[1]!) : undefined;
}

function parseDoubleQuotedString(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsePluginIdentifier(
  value: string,
): { pluginName: string; marketplaceName: string } | undefined {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const pluginName = value.slice(0, separator);
  const marketplaceName = value.slice(separator + 1);
  return isSafePluginSegment(pluginName) && isSafePluginSegment(marketplaceName)
    ? { pluginName, marketplaceName }
    : undefined;
}

function isSafePluginSegment(value: string): boolean {
  return isInvocationName(value) && value !== '.' && value !== '..' && !/[\\/]/u.test(value);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function existingDirectory(candidate: string): Promise<string | undefined> {
  try {
    return (await stat(candidate)).isDirectory() ? path.resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function providerLabel(provider: ActoviqSkillCatalogProvider): string {
  switch (provider) {
    case 'claude-code': return 'Claude Code';
    case 'cc-switch': return 'cc-switch';
    case 'agents': return 'Shared agent configuration';
    case 'actoviq': return 'Actoviq';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
  }
}

function bundledCandidates(source: SkillSourceDescriptor): SkillCandidate[] {
  return getDefaultActoviqBundledSkills().map(definition => {
    const serialized = JSON.stringify({
      name: definition.name,
      description: definition.description,
      prompt: definition.prompt ?? '',
      version: definition.version,
    });
    const contentHash = hashContent(serialized);
    return {
      name: definition.name,
      aliases: [],
      directoryName: definition.name,
      description: definition.description,
      version: definition.version,
      invalid: false,
      contentHash,
      capabilities: [],
      declaredAllowedTools: [...(definition.allowedTools ?? [])],
      frontmatterKeys: [],
      origins: [originFromSource(source, definition.name, 'bundled')],
      diagnostics: [],
    };
  });
}

async function scanSkillSource(
  source: SkillSourceDescriptor,
  options: DiscoverActoviqSkillCatalogOptions,
  diagnostics: ActoviqSkillCatalogDiagnostic[],
): Promise<SkillCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(source.root!, { withFileTypes: true });
    source.status = source.needsTrust ? 'needs-trust' : 'ready';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      source.status = 'missing';
      return [];
    }
    source.status = 'unreadable';
    diagnostics.push({
      code: 'source-unreadable',
      severity: 'error',
      sourceId: source.id,
      path: source.root,
      message: `Unable to read skill source ${source.label}.`,
    });
    return [];
  }

  const skillEntries = entries
    .filter(entry =>
      (entry.isDirectory() || entry.isSymbolicLink())
      && !source.excludeDirectoryNames.has(entry.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const results = await mapWithConcurrency(
    skillEntries,
    normalizedConcurrency(options.scanConcurrency),
    entry => scanSkillEntry(source, entry, options, diagnostics),
  );
  return results.filter((candidate): candidate is SkillCandidate => candidate !== undefined);
}

async function scanSkillEntry(
  source: SkillSourceDescriptor,
  entry: Dirent,
  options: DiscoverActoviqSkillCatalogOptions,
  diagnostics: ActoviqSkillCatalogDiagnostic[],
): Promise<SkillCandidate | undefined> {
  const skillRoot = path.join(source.root!, entry.name);
  return scanSkillFile(source, {
    directoryName: entry.name,
    fallbackName: entry.name,
    skillRoot,
    skillFile: path.join(skillRoot, 'SKILL.md'),
    loadedFrom: 'skills',
    declaredNameWins: true,
  }, options, diagnostics);
}

async function scanCommandSkillSource(
  source: SkillSourceDescriptor,
  options: DiscoverActoviqSkillCatalogOptions,
  diagnostics: ActoviqSkillCatalogDiagnostic[],
): Promise<SkillCandidate[]> {
  let files: string[];
  try {
    await readdir(source.root!);
    source.status = source.needsTrust ? 'needs-trust' : 'ready';
    files = await walkCommandMarkdownFiles(source.root!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      source.status = 'missing';
      return [];
    }
    source.status = 'unreadable';
    diagnostics.push({
      code: 'source-unreadable',
      severity: 'error',
      sourceId: source.id,
      path: source.root,
      message: `Unable to read skill source ${source.label}.`,
    });
    return [];
  }

  const results = await mapWithConcurrency(
    files,
    normalizedConcurrency(options.scanConcurrency),
    (skillFile) => {
      const relativeFile = path.relative(source.root!, skillFile);
      const isSkillFile = path.basename(skillFile).toUpperCase() === 'SKILL.MD';
      const relativeName = isSkillFile
        ? path.dirname(relativeFile)
        : relativeFile.replace(/\.md$/iu, '');
      const fallbackName = relativeName.split(path.sep).filter(Boolean).join(':');
      return scanSkillFile(source, {
        directoryName: relativeFile.replaceAll(path.sep, '/'),
        fallbackName,
        skillRoot: path.dirname(skillFile),
        skillFile,
        loadedFrom: 'commands',
        declaredNameWins: false,
      }, options, diagnostics);
    },
  );
  return results.filter((candidate): candidate is SkillCandidate => candidate !== undefined);
}

async function walkCommandMarkdownFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const visit = async (currentDir: string): Promise<void> => {
    const entries = (await readdir(currentDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    await Promise.all(entries.map(async entry => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(fullPath);
      }
    }));
  };
  await visit(rootDir);

  const byDirectory = new Map<string, string[]>();
  for (const filePath of results) {
    const directory = path.dirname(filePath);
    const entries = byDirectory.get(directory) ?? [];
    entries.push(filePath);
    byDirectory.set(directory, entries);
  }
  return [...byDirectory.values()]
    .flatMap(entries => entries.find(filePath => path.basename(filePath).toUpperCase() === 'SKILL.MD')
      ?? entries.sort((left, right) => left.localeCompare(right)))
    .flat()
    .sort((left, right) => left.localeCompare(right));
}

interface SkillFileDescriptor {
  directoryName: string;
  fallbackName: string;
  skillRoot: string;
  skillFile: string;
  loadedFrom: 'skills' | 'commands';
  declaredNameWins: boolean;
}

async function scanSkillFile(
  source: SkillSourceDescriptor,
  descriptor: SkillFileDescriptor,
  options: DiscoverActoviqSkillCatalogOptions,
  diagnostics: ActoviqSkillCatalogDiagnostic[],
): Promise<SkillCandidate | undefined> {
  const { directoryName, fallbackName, skillRoot, skillFile } = descriptor;
  let fileStat;
  try {
    fileStat = await stat(skillFile);
    if (!fileStat.isFile()) throw new Error('Skill definition is not a file.');
  } catch {
    diagnostics.push({
      code: 'missing-skill-file',
      severity: 'warning',
      sourceId: source.id,
      path: skillRoot,
      message: `Skipped ${fallbackName}: the skill definition was not found.`,
    });
    return undefined;
  }

  const maxSkillBytes = normalizedMaxSkillBytes(options.maxSkillBytes);
  if (fileStat.size > maxSkillBytes) {
    diagnostics.push({
      code: 'skill-too-large',
      severity: 'error',
      sourceId: source.id,
      path: skillFile,
      message: `Skipped ${fallbackName}: the skill definition exceeds ${maxSkillBytes} bytes.`,
    });
    return undefined;
  }

  try {
    const [raw, canonicalSkillRoot, canonicalSkillFile, capabilities] = await Promise.all([
      readFile(skillFile, 'utf8'),
      realpath(skillRoot),
      realpath(skillFile),
      detectCapabilities(skillRoot),
    ]);
    const parsed = parseSkillFrontmatter(raw);
    const contentHash = hashContent(raw);
    const diagnosticsForSkill: ActoviqSkillCatalogDiagnostic[] = parsed.diagnostics.map(item => ({
      ...item,
      severity: 'error',
      sourceId: source.id,
      path: skillFile,
    }));
    const declaredName = parsed.values.name?.trim();
    let aliases: string[] = [];
    let name: string;
    if (descriptor.declaredNameWins && declaredName && isInvocationName(declaredName)) {
      name = declaredName;
      if (declaredName !== fallbackName) aliases.push(fallbackName);
    } else if (isInvocationName(fallbackName)) {
      name = fallbackName;
      if (declaredName && declaredName !== fallbackName) aliases.push(declaredName);
    } else {
      name = sanitizeInvocationName(
        descriptor.declaredNameWins ? declaredName || fallbackName : fallbackName,
        contentHash,
      );
      aliases.push(fallbackName);
    }
    if ((declaredName && !isInvocationName(declaredName)) || !isInvocationName(fallbackName)) {
      diagnosticsForSkill.push({
        code: 'invalid-name',
        severity: 'warning',
        sourceId: source.id,
        path: skillFile,
        message: `Normalized non-invocable skill name to "${name}".`,
      });
    }
    if (source.invocationPrefix) {
      name = `${source.invocationPrefix}:${name}`;
      aliases = aliases.map(alias => `${source.invocationPrefix}:${alias}`);
    }
    diagnostics.push(...diagnosticsForSkill);

    return {
      name,
      aliases: uniqueSorted(aliases.filter(alias => alias !== name)),
      directoryName,
      description: normalizeDescription(parsed.values.description, parsed.body, name),
      version: nonEmpty(parsed.values.version),
      invalid: parsed.invalid,
      contentHash,
      capabilities,
      declaredAllowedTools: parseStringList(parsed.values['allowed-tools']),
      frontmatterKeys: Object.keys(parsed.values).sort(),
      origins: [{
        ...originFromSource(source, directoryName, descriptor.loadedFrom),
        skillRoot,
        canonicalSkillRoot,
        skillFile,
        canonicalSkillFile,
      }],
      diagnostics: diagnosticsForSkill,
    };
  } catch {
    diagnostics.push({
      code: 'skill-unreadable',
      severity: 'error',
      sourceId: source.id,
      path: skillFile,
      message: `Unable to read skill ${fallbackName}.`,
    });
    return undefined;
  }
}

function originFromSource(
  source: SkillSourceDescriptor,
  directoryName: string,
  loadedFrom: ActoviqSkillCatalogOrigin['loadedFrom'] = 'skills',
): ActoviqSkillCatalogOrigin {
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    provider: source.provider,
    scope: source.scope,
    directoryName,
    loadedFrom,
    readOnly: source.readOnly,
    needsTrust: source.needsTrust,
  };
}

async function detectCapabilities(skillRoot: string): Promise<ActoviqSkillCatalogCapability[]> {
  const names: ActoviqSkillCatalogCapability[] = ['assets', 'references', 'scripts'];
  const found = await Promise.all(names.map(async name => {
    try {
      return (await stat(path.join(skillRoot, name))).isDirectory() ? name : undefined;
    } catch {
      return undefined;
    }
  }));
  return found.filter((name): name is ActoviqSkillCatalogCapability => name !== undefined);
}

function deduplicateCandidates(candidates: SkillCandidate[]): ActoviqSkillCatalogEntry[] {
  const byCanonicalPath = new Map<string, ActoviqSkillCatalogEntry>();
  const byNameAndHash = new Map<string, ActoviqSkillCatalogEntry>();
  const skills: ActoviqSkillCatalogEntry[] = [];

  for (const candidate of candidates) {
    const canonicalFile = candidate.origins[0]?.canonicalSkillFile;
    const pathKey = canonicalFile
      ? `${candidate.name}\0${comparablePath(canonicalFile)}`
      : undefined;
    const hashKey = `${candidate.name}\0${candidate.contentHash}`;
    const existing = (pathKey ? byCanonicalPath.get(pathKey) : undefined)
      ?? byNameAndHash.get(hashKey);
    if (existing) {
      mergeCandidate(existing, candidate);
      if (pathKey) byCanonicalPath.set(pathKey, existing);
      byNameAndHash.set(hashKey, existing);
      continue;
    }

    const firstOrigin = candidate.origins[0]!;
    const skill: ActoviqSkillCatalogEntry = {
      id: skillId(candidate.name, firstOrigin),
      name: candidate.name,
      aliases: uniqueSorted(candidate.aliases),
      directoryName: candidate.directoryName,
      description: candidate.description,
      version: candidate.version,
      status: candidate.invalid
        ? 'invalid'
        : firstOrigin.needsTrust ? 'needs-trust' : 'ready',
      conflict: false,
      contentHash: candidate.contentHash,
      sourceId: firstOrigin.sourceId,
      provider: firstOrigin.provider,
      scope: firstOrigin.scope,
      skillRoot: firstOrigin.skillRoot,
      canonicalSkillRoot: firstOrigin.canonicalSkillRoot,
      readOnly: firstOrigin.readOnly,
      needsTrust: firstOrigin.needsTrust,
      capabilities: [...candidate.capabilities],
      declaredAllowedTools: [...candidate.declaredAllowedTools],
      frontmatterKeys: [...candidate.frontmatterKeys],
      origins: [...candidate.origins],
      diagnostics: [...candidate.diagnostics],
    };
    skills.push(skill);
    if (pathKey) byCanonicalPath.set(pathKey, skill);
    byNameAndHash.set(hashKey, skill);
  }

  return skills;
}

function mergeCandidate(entry: ActoviqSkillCatalogEntry, candidate: SkillCandidate): void {
  entry.aliases = uniqueSorted([...entry.aliases, ...candidate.aliases]);
  entry.capabilities = uniqueSorted([
    ...entry.capabilities,
    ...candidate.capabilities,
  ]) as ActoviqSkillCatalogCapability[];
  entry.declaredAllowedTools = uniqueSorted([
    ...entry.declaredAllowedTools,
    ...candidate.declaredAllowedTools,
  ]);
  entry.frontmatterKeys = uniqueSorted([
    ...entry.frontmatterKeys,
    ...candidate.frontmatterKeys,
  ]);
  entry.origins.push(...candidate.origins);
  entry.diagnostics.push(...candidate.diagnostics);
  entry.readOnly = entry.origins.every(origin => origin.readOnly);
  entry.needsTrust = entry.origins.every(origin => origin.needsTrust);
  if (entry.status !== 'invalid') {
    entry.status = entry.needsTrust ? 'needs-trust' : 'ready';
  }
}

function markConflicts(skills: ActoviqSkillCatalogEntry[]): ActoviqSkillCatalogConflict[] {
  const byName = new Map<string, ActoviqSkillCatalogEntry[]>();
  for (const skill of skills) {
    const entries = byName.get(skill.name) ?? [];
    entries.push(skill);
    byName.set(skill.name, entries);
  }

  const conflicts: ActoviqSkillCatalogConflict[] = [];
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    for (const entry of entries) entry.conflict = true;
    conflicts.push({
      name,
      skillIds: entries.map(entry => entry.id).sort(),
      contentHashes: entries.map(entry => entry.contentHash).sort(),
      sourceIds: uniqueSorted(entries.flatMap(entry => entry.origins.map(origin => origin.sourceId))),
    });
  }
  return conflicts.sort((left, right) => left.name.localeCompare(right.name));
}

function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { values: {}, body: normalized.trim(), diagnostics: [], invalid: false };
  }

  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closeIndex < 0) {
    return {
      values: {},
      body: normalized.trim(),
      diagnostics: [{
        code: 'invalid-frontmatter',
        message: 'Frontmatter opening delimiter has no closing delimiter.',
      }],
      invalid: true,
    };
  }

  const values: Record<string, string> = {};
  const frontmatterLines = lines.slice(1, closeIndex);
  for (let index = 0; index < frontmatterLines.length;) {
    const line = frontmatterLines[index]!;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1]!;
    const rawValue = match[2]!.trim();
    const block = rawValue.match(/^([>|])([+-]?)$/u);
    if (!block) {
      values[key] = parseScalar(rawValue);
      index += 1;
      continue;
    }

    const blockLines: string[] = [];
    index += 1;
    while (index < frontmatterLines.length) {
      const next = frontmatterLines[index]!;
      if (next.trim() && !/^\s/u.test(next)) break;
      blockLines.push(next);
      index += 1;
    }
    const normalizedBlock = stripCommonIndent(blockLines);
    values[key] = block[1] === '|'
      ? normalizedBlock.join('\n').replace(/\n+$/u, '')
      : foldBlockLines(normalizedBlock);
  }

  return {
    values,
    body: lines.slice(closeIndex + 1).join('\n').trim(),
    diagnostics: [],
    invalid: false,
  };
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  const doubleQuoted = trimmed.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/u);
  if (doubleQuoted) {
    try {
      const parsed = JSON.parse(doubleQuoted[1]!) as unknown;
      return typeof parsed === 'string' ? parsed : doubleQuoted[1]!.slice(1, -1);
    } catch {
      return doubleQuoted[1]!.slice(1, -1);
    }
  }
  const singleQuoted = trimmed.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/u);
  if (singleQuoted) {
    return singleQuoted[1]!.replace(/''/gu, "'");
  }
  return trimmed.replace(/\s+#.*$/u, '').trim();
}

function stripCommonIndent(lines: string[]): string[] {
  const indents = lines
    .filter(line => line.trim())
    .map(line => line.match(/^\s*/u)?.[0].length ?? 0);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map(line => line.trim() ? line.slice(commonIndent) : '');
}

function foldBlockLines(lines: string[]): string {
  let result = '';
  let previousBlank = true;
  for (const line of lines) {
    const blank = line.length === 0;
    if (blank) {
      result = result.replace(/[ \t]+$/u, '') + '\n';
    } else if (!previousBlank && result) {
      result += ` ${line}`;
    } else {
      result += line;
    }
    previousBlank = blank;
  }
  return result.replace(/\n+$/u, '').trim();
}

function normalizeDescription(value: string | undefined, body: string, name: string): string {
  const explicit = value?.trim();
  if (explicit) return explicit;
  const firstBodyLine = body
    .split(/\r?\n/gu)
    .map(line => line.replace(/^#+\s*/u, '').trim())
    .find(Boolean);
  return firstBodyLine?.slice(0, 240) || `Run the ${name} skill.`;
}

function parseStringList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const trimmed = value.trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return uniqueSorted(body
    .split(',')
    .map(item => parseScalar(item.trim()))
    .filter(Boolean));
}

function isInvocationName(value: string): boolean {
  return Boolean(value)
    && value.length <= 128
    && !/[\s/\\\u0000-\u001f\u007f]/u.test(value);
}

function sanitizeInvocationName(value: string, contentHash: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[/\\\u0000-\u001f\u007f]/gu, '')
    .replace(/-+/gu, '-')
    .slice(0, 128);
  return normalized || `skill-${contentHash.slice(0, 8)}`;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function skillId(name: string, origin: ActoviqSkillCatalogOrigin): string {
  return `skill:${hashContent(`${name}\0${origin.sourceId}\0${origin.directoryName}`).slice(0, 24)}`;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizedMaxSkillBytes(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : DEFAULT_MAX_SKILL_BYTES;
}

function normalizedConcurrency(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0
    ? Math.min(value!, 32)
    : DEFAULT_SCAN_CONCURRENCY;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function toPublicSource(source: SkillSourceDescriptor): ActoviqSkillCatalogSource {
  return {
    id: source.id,
    label: source.label,
    provider: source.provider,
    scope: source.scope,
    root: source.root,
    managedBy: source.managedBy,
    readOnly: source.readOnly,
    needsTrust: source.needsTrust,
    status: source.status,
    skillCount: source.skillCount,
  };
}

function compareSkills(left: ActoviqSkillCatalogEntry, right: ActoviqSkillCatalogEntry): number {
  return left.name.localeCompare(right.name) || left.contentHash.localeCompare(right.contentHash);
}

function compareDiagnostics(
  left: ActoviqSkillCatalogDiagnostic,
  right: ActoviqSkillCatalogDiagnostic,
): number {
  return left.sourceId.localeCompare(right.sourceId)
    || (left.path ?? '').localeCompare(right.path ?? '')
    || left.code.localeCompare(right.code);
}
