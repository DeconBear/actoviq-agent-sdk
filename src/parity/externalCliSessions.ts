import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { createReadStream, realpath as realpathCallback } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveHadamardHome } from '../config/hadamardHome.js';
import { HadamardSdkError } from '../errors.js';
import {
  isCrushSessionReference,
  listCrushSessionHistory,
  parseCrushSessionReferenceDetails,
  readCrushSessionHistory,
  type CrushHistoryCommandRunner,
  type CrushSessionHistoryOptions,
} from './crushSessionHistory.js';
import {
  parseReasonixSessionJsonl,
  resolveReasonixSessionRoots,
  type ReasonixSessionMessage,
} from './reasonixSessionParser.js';

/** Prefer native realpath so Windows 8.3 short names canonicalize consistently. */
const realpathNative = promisify(realpathCallback.native);

export type ExternalCliRuntime = 'claude' | 'codex' | 'pi' | 'codewhale' | 'reasonix' | 'crush';
export type ExternalCliSessionRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ExternalCliToolMetadata {
  kind: 'call' | 'result';
  id?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface ExternalCliSessionMessage {
  role: ExternalCliSessionRole;
  text: string;
  timestamp?: string;
  model?: string;
  tools?: ExternalCliToolMetadata[];
}

export interface ExternalCliSessionSummary {
  runtime: ExternalCliRuntime;
  nativeSessionId: string;
  title: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  path: string;
  /** True when messageCount was produced by a bounded scan rather than a full transcript scan. */
  truncated?: boolean;
}

export interface ExternalCliSession {
  summary: ExternalCliSessionSummary;
  messages: ExternalCliSessionMessage[];
  /** True when the configured byte or message limit stopped the detail scan early. */
  truncated?: boolean;
}

export interface ExternalCliSessionOptions {
  /** Used only to derive the default Claude, Codex, Pi, CodeWhale, and Reasonix session roots. */
  homeDir?: string;
  /** Direct Hadamard data root used for isolated managed-profile history. */
  hadamardHomeDir?: string;
  claudeRoot?: string;
  codexRoot?: string;
  piRoot?: string;
  codewhaleRoot?: string;
  reasonixRoot?: string;
  /** Crush history is command-backed and scoped to this project directory. */
  crushCwd?: string;
  crushExecutable?: string;
  crushEnv?: Record<string, string>;
  crushCommandRunner?: CrushHistoryCommandRunner;
  /** Optional runtime filter applied before any session file is opened. */
  runtimes?: ExternalCliRuntime[];
  /** Optional pagination applied after files are sorted by filesystem modification time. */
  limit?: number;
  offset?: number;
  /** Bounds for the lightweight scan used by listExternalCliSessions. */
  summaryMaxBytes?: number;
  summaryMaxMessages?: number;
  /** Bounds for the transcript scan used by readExternalCliSession. */
  detailMaxBytes?: number;
  detailMaxMessages?: number;
}

export interface ExternalCliSessionConfigIdentity {
  runtime: ExternalCliRuntime;
  authSource?: 'native' | 'apiKey';
  profileName?: string;
}

export interface CodewhaleNativeSessionCorrelationOptions {
  correlationHint: string;
  cwd: string;
  startedAtMs: number;
  finishedAtMs?: number;
  clockSkewMs?: number;
  homeDir?: string;
  codewhaleRoot?: string;
}

interface RootSpec {
  runtime: ExternalCliRuntime;
  root: string;
}

interface ManagedCrushHistoryProfile {
  id: string;
  dataDir: string;
}

interface ParseState {
  nativeSessionId?: string;
  nativeTitle?: string;
  cwd?: string;
  model?: string;
  earliestTimestamp?: number;
  latestTimestamp?: number;
  messages: ExternalCliSessionMessage[];
  fallbackMessages: ExternalCliSessionMessage[];
  piEntries: PiSessionEntry[];
  piMessageCount: number;
}

interface PiSessionEntry {
  id: string;
  parentId: string | null;
  record: Record<string, unknown>;
}

interface ExtractedContent {
  text: string;
  tools: ExternalCliToolMetadata[];
  toolResultOnly: boolean;
}

interface SessionFileCandidate {
  runtime: ExternalCliRuntime;
  path: string;
  stats: Stats;
}

interface ParseBounds {
  maxBytes: number;
  maxMessages: number;
}

interface CodewhaleSavedSessionPrefix {
  source: string;
  savedSession?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  bytesToRead: number;
}

interface SummaryCacheEntry {
  runtime: ExternalCliRuntime;
  mtimeMs: number;
  size: number;
  maxBytes: number;
  maxMessages: number;
  summary: ExternalCliSessionSummary;
}

const DEFAULT_SUMMARY_MAX_BYTES = 128 * 1024;
const DEFAULT_SUMMARY_MAX_MESSAGES = 512;
const DEFAULT_DETAIL_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_DETAIL_MAX_MESSAGES = 4_000;
const MAX_REASONIX_METADATA_BYTES = 256 * 1024;
const MAX_SUMMARY_CACHE_ENTRIES = 1_000;
const DEFAULT_CODEWHALE_CORRELATION_CLOCK_SKEW_MS = 5_000;
const CODEWHALE_LOG_FINGERPRINT_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const CODEWHALE_LOG_FINGERPRINT_PRIME = 0x0000_0100_0000_01b3n;
const CODEWHALE_REDACTED_IDENTIFIER = /^<redacted:[0-9a-f]{16}>$/u;
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_MANAGED_PROFILES_PER_RUNTIME = 256;
const MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY = 8;
const ISOLATED_MANAGED_PROFILE_RUNTIMES = new Set<ExternalCliRuntime>([
  'pi',
  'codewhale',
  'reasonix',
  'crush',
]);

const summaryCache = new Map<string, SummaryCacheEntry>();

export function namedExternalCliManagedProfileId(
  runtime: ExternalCliRuntime,
  profileName: string,
): string {
  const normalizedName = profileName.trim();
  if (!normalizedName) throw new TypeError('External CLI managed profile name is required.');
  return createHash('sha256')
    .update(`${runtime}\0name:${normalizedName}`)
    .digest('hex');
}

function sessionManagedProfileId(
  summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): string | undefined {
  if (summary.runtime === 'crush') {
    return parseCrushSessionReferenceDetails(summary.path)?.managedProfileId;
  }
  if (!ISOLATED_MANAGED_PROFILE_RUNTIMES.has(summary.runtime)) return undefined;
  const runtimeRoot = path.resolve(
    resolveManagedHadamardHome(options),
    'external-cli-profiles',
    summary.runtime,
  );
  const relative = path.relative(runtimeRoot, path.resolve(summary.path));
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const [profileId] = relative.split(path.sep);
  return MANAGED_PROFILE_ID_PATTERN.test(profileId ?? '') ? profileId : undefined;
}

/**
 * Bind a discovered history entry to the same native-login or isolated-key
 * store used by a saved CLI config. Runtime + native session id alone is not
 * sufficient because different stores may legally reuse the same id.
 */
export function externalCliSessionMatchesConfig(
  summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
  config: ExternalCliSessionConfigIdentity,
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'> = {},
): boolean {
  if (summary.runtime !== config.runtime) return false;
  if (!ISOLATED_MANAGED_PROFILE_RUNTIMES.has(summary.runtime)) return true;
  const actualProfileId = sessionManagedProfileId(summary, options);
  if (config.authSource !== 'apiKey') return actualProfileId === undefined;
  if (!config.profileName?.trim()) return false;
  return actualProfileId === namedExternalCliManagedProfileId(
    summary.runtime,
    config.profileName,
  );
}

/** Matches CodeWhale's official redacted_identifier_for_log correlation value. */
export function codewhaleRedactedIdentifierForLog(identifier: string): string {
  if (!identifier) {
    return '<redacted:empty>';
  }

  const bytes = Buffer.from(identifier, 'utf8');
  let hash = CODEWHALE_LOG_FINGERPRINT_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(byte)) * CODEWHALE_LOG_FINGERPRINT_PRIME,
    );
  }
  hash = BigInt.asUintN(
    64,
    (hash ^ BigInt(bytes.length)) * CODEWHALE_LOG_FINGERPRINT_PRIME,
  );
  return `<redacted:${hash.toString(16).padStart(16, '0')}>`;
}

export async function resolveCodewhaleNativeSessionId(
  options: CodewhaleNativeSessionCorrelationOptions,
): Promise<string | undefined> {
  const finishedAtMs = options.finishedAtMs ?? Date.now();
  if (
    !CODEWHALE_REDACTED_IDENTIFIER.test(options.correlationHint)
    || !options.cwd.trim()
    || !Number.isFinite(options.startedAtMs)
    || !Number.isFinite(finishedAtMs)
    || finishedAtMs < options.startedAtMs
  ) {
    return undefined;
  }

  const clockSkewMs = normalizedNonNegativeInteger(
    options.clockSkewMs,
    DEFAULT_CODEWHALE_CORRELATION_CLOCK_SKEW_MS,
  );
  const earliestMtimeMs = options.startedAtMs - clockSkewMs;
  const latestMtimeMs = finishedAtMs + clockSkewMs;
  const nativeSessionIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const configuredRoot of await getConfiguredRoots(options)) {
    if (configuredRoot.runtime !== 'codewhale') {
      continue;
    }
    const root = await resolveDirectory(configuredRoot.root);
    if (!root) {
      continue;
    }
    for (const filePath of await collectCodewhaleSessionFiles(root)) {
      const candidate = await inspectSessionFile('codewhale', root, filePath);
      if (
        !candidate
        || seenPaths.has(candidate.path)
        || candidate.stats.mtimeMs < earliestMtimeMs
        || candidate.stats.mtimeMs > latestMtimeMs
      ) {
        continue;
      }
      seenPaths.add(candidate.path);
      const savedSession = await readCodewhaleSavedSessionPrefix(
        candidate.path,
        candidate.stats,
        DEFAULT_SUMMARY_MAX_BYTES,
      );
      if (!savedSession) {
        continue;
      }
      const nativeSessionId = stringValue(savedSession.metadata.id);
      const workspace = stringValue(savedSession.metadata.workspace);
      if (
        nativeSessionId
        && workspace
        && sameResolvedPath(workspace, options.cwd)
        && codewhaleRedactedIdentifierForLog(nativeSessionId) === options.correlationHint
      ) {
        nativeSessionIds.add(nativeSessionId);
      }
    }
  }

  return nativeSessionIds.size === 1 ? nativeSessionIds.values().next().value : undefined;
}

export async function listExternalCliSessions(
  options: ExternalCliSessionOptions = {},
): Promise<ExternalCliSessionSummary[]> {
  const candidates: SessionFileCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const configuredRoot of await getConfiguredRoots(options)) {
    if (options.runtimes?.length && !options.runtimes.includes(configuredRoot.runtime)) {
      continue;
    }
    const root = await resolveDirectory(configuredRoot.root);
    if (!root) {
      continue;
    }

    const sessionFiles = configuredRoot.runtime === 'codewhale'
      ? await collectCodewhaleSessionFiles(root)
      : configuredRoot.runtime === 'reasonix'
        ? await collectReasonixSessionFiles(root)
        : await collectJsonlFiles(root);
    for (const filePath of sessionFiles) {
      const candidate = await inspectSessionFile(configuredRoot.runtime, root, filePath);
      if (!candidate || seenPaths.has(candidate.path)) {
        continue;
      }
      seenPaths.add(candidate.path);
      candidates.push(candidate);
    }
  }

  const includeCrush = options.runtimes?.includes('crush') === true
    || (!options.runtimes?.length && Boolean(options.crushCwd));
  const managedCrushProfiles = includeCrush
    ? await managedCrushHistoryProfiles(options)
    : [];
  const crushHistorySources = includeCrush
    ? [
        toCrushHistoryOptions(options),
        ...managedCrushProfiles.map(profile => toCrushHistoryOptions(options, profile)),
      ]
    : [];
  const crushSummaries: ExternalCliSessionSummary[] = [];
  for (
    let sourceIndex = 0;
    sourceIndex < crushHistorySources.length;
    sourceIndex += MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY
  ) {
    const summaryGroups = await Promise.all(
      crushHistorySources
        .slice(sourceIndex, sourceIndex + MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY)
        .map(source => listCrushSessionHistory(source).catch(() => [])),
    );
    crushSummaries.push(...summaryGroups.flat());
  }
  const entries: Array<
    | { kind: 'file'; candidate: SessionFileCandidate; sortTime: number; path: string }
    | { kind: 'crush'; summary: ExternalCliSessionSummary; sortTime: number; path: string }
  > = [
    ...candidates.map(candidate => ({
      kind: 'file' as const,
      candidate,
      sortTime: candidate.stats.mtimeMs,
      path: candidate.path,
    })),
    ...crushSummaries.map(summary => ({
      kind: 'crush' as const,
      summary,
      sortTime: Date.parse(summary.updatedAt),
      path: summary.path,
    })),
  ];
  entries.sort((left, right) => {
    const timeDifference = right.sortTime - left.sortTime;
    return timeDifference || left.path.localeCompare(right.path);
  });

  const offset = normalizedNonNegativeInteger(options.offset, 0);
  const limit = options.limit == null
    ? entries.length
    : normalizedNonNegativeInteger(options.limit, entries.length);
  const selectedEntries = entries.slice(offset, offset + limit);
  const bounds: ParseBounds = {
    maxBytes: normalizedPositiveInteger(options.summaryMaxBytes, DEFAULT_SUMMARY_MAX_BYTES),
    maxMessages: normalizedPositiveInteger(
      options.summaryMaxMessages,
      DEFAULT_SUMMARY_MAX_MESSAGES,
    ),
  };
  const summaries: ExternalCliSessionSummary[] = [];

  for (const entry of selectedEntries) {
    if (entry.kind === 'crush') {
      summaries.push(entry.summary);
      continue;
    }
    const candidate = entry.candidate;
    // Reasonix summary fields can change in a metadata sidecar while the
    // checkpoint JSONL itself remains untouched.
    const cached = candidate.runtime === 'reasonix'
      ? undefined
      : getCachedSummary(candidate, bounds);
    if (cached) {
      summaries.push(cached);
      continue;
    }

    const session = await parseSessionFile(
      candidate.runtime,
      candidate.path,
      bounds,
      candidate.stats,
    );
    if (session) {
      if (candidate.runtime !== 'reasonix') {
        cacheSummary(candidate, bounds, session.summary);
      }
      summaries.push(session.summary);
    }
  }

  return summaries;
}

export async function readExternalCliSession(
  filePath: string,
  options: ExternalCliSessionOptions = {},
): Promise<ExternalCliSession | undefined> {
  if (isCrushSessionReference(filePath)) {
    if (options.runtimes?.length && !options.runtimes.includes('crush')) return undefined;
    const reference = parseCrushSessionReferenceDetails(filePath);
    if (!reference) return undefined;
    if (!reference.managedProfileId) {
      return readCrushSessionHistory(filePath, toCrushHistoryOptions(options));
    }
    const profile = (await managedCrushHistoryProfiles(options))
      .find(candidate => candidate.id === reference.managedProfileId);
    if (!profile) return undefined;
    return readCrushSessionHistory(filePath, toCrushHistoryOptions(options, profile));
  }
  const requestedPath = path.resolve(filePath);
  const canonicalPath = await resolveFile(requestedPath);
  if (!canonicalPath) {
    return undefined;
  }

  // Canonicalize roots before containment checks so Windows short/long path
  // forms of the same directory are not treated as distinct trees.
  const allowedRoots: RootSpec[] = [];
  for (const configuredRoot of await getConfiguredRoots(options)) {
    const canonicalRoot = await resolveDirectory(configuredRoot.root);
    if (canonicalRoot && isPathInside(canonicalRoot, canonicalPath)) {
      allowedRoots.push({ ...configuredRoot, root: canonicalRoot });
    }
  }

  if (allowedRoots.length === 0) {
    throw unsafeSessionPath(requestedPath);
  }

  const root = allowedRoots
    .filter(allowedRoot => isSessionFileForRuntime(allowedRoot, canonicalPath))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (!root) {
    return undefined;
  }
  return parseSessionFile(root.runtime, canonicalPath, {
    maxBytes: normalizedPositiveInteger(options.detailMaxBytes, DEFAULT_DETAIL_MAX_BYTES),
    maxMessages: normalizedPositiveInteger(options.detailMaxMessages, DEFAULT_DETAIL_MAX_MESSAGES),
  });
}

function toCrushHistoryOptions(
  options: ExternalCliSessionOptions,
  profile?: ManagedCrushHistoryProfile,
): CrushSessionHistoryOptions {
  return {
    executable: options.crushExecutable,
    cwd: options.crushCwd,
    env: profile
      ? { ...options.crushEnv, CRUSH_GLOBAL_DATA: profile.dataDir }
      : options.crushEnv,
    commandRunner: options.crushCommandRunner,
    maxOutputBytes: options.detailMaxBytes,
    maxMessages: options.detailMaxMessages,
    managedProfileId: profile?.id,
  };
}

async function getConfiguredRoots(options: ExternalCliSessionOptions): Promise<RootSpec[]> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const explicitRootMode = Boolean(
    options.claudeRoot
    || options.codexRoot
    || options.piRoot
    || options.codewhaleRoot
    || options.reasonixRoot,
  );
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(homeDir, '.claude');
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homeDir, '.codex');
  const piSessions = process.env.PI_CODING_AGENT_SESSION_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : process.env.PI_CODING_AGENT_DIR
      ? path.join(path.resolve(process.env.PI_CODING_AGENT_DIR), 'sessions')
      : path.join(homeDir, '.pi', 'agent', 'sessions');
  const codewhaleRoots = options.codewhaleRoot
    ? [path.resolve(options.codewhaleRoot)]
    : process.env.CODEWHALE_HOME
      ? [path.join(path.resolve(process.env.CODEWHALE_HOME), 'sessions')]
      : [
          path.join(homeDir, '.codewhale', 'sessions'),
          path.join(homeDir, '.deepseek', 'sessions'),
        ];
  const reasonixRoots = options.reasonixRoot
    ? [path.resolve(options.reasonixRoot)]
    : resolveReasonixSessionRoots(
        homeDir,
        options.homeDir && !sameResolvedPath(homeDir, os.homedir())
          ? { ...process.env, APPDATA: undefined }
          : process.env,
      );
  const roots: RootSpec[] = [
    ...(!explicitRootMode || options.claudeRoot ? [{
      runtime: 'claude',
      root: path.resolve(options.claudeRoot ?? path.join(claudeConfigDir, 'projects')),
    } as const] : []),
    ...(!explicitRootMode || options.codexRoot ? [{
      runtime: 'codex',
      root: path.resolve(options.codexRoot ?? path.join(codexHome, 'sessions')),
    } as const] : []),
    ...(!explicitRootMode || options.piRoot ? [{
      runtime: 'pi',
      root: path.resolve(options.piRoot ?? piSessions),
    } as const] : []),
    ...(!explicitRootMode || options.codewhaleRoot ? codewhaleRoots.map(root => ({
      runtime: 'codewhale' as const,
      root,
    })) : []),
    ...(!explicitRootMode || options.reasonixRoot ? reasonixRoots.map(root => ({
      runtime: 'reasonix' as const,
      root,
    })) : []),
  ];
  if (!explicitRootMode) {
    roots.push(...await managedExternalCliProfileRoots(options));
  }
  const seen = new Set<string>();
  return roots.filter(item => {
    const normalized = path.resolve(item.root);
    const key = `${item.runtime}\0${path.sep === '\\' ? normalized.toLowerCase() : normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function managedExternalCliProfileRoots(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): Promise<RootSpec[]> {
  const profilesRoot = path.join(resolveManagedHadamardHome(options), 'external-cli-profiles');
  const roots: RootSpec[] = [];
  for (const runtime of ['pi', 'codewhale', 'reasonix'] as const) {
    const runtimeRoot = path.join(profilesRoot, runtime);
    let entries: Dirent[];
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .filter(candidate =>
        candidate.isDirectory() && MANAGED_PROFILE_ID_PATTERN.test(candidate.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_MANAGED_PROFILES_PER_RUNTIME)) {
      roots.push({
        runtime,
        root: runtime === 'reasonix'
          ? path.join(runtimeRoot, entry.name, '.reasonix', 'sessions')
          : path.join(runtimeRoot, entry.name, 'sessions'),
      });
    }
  }
  return roots;
}

async function managedCrushHistoryProfiles(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): Promise<ManagedCrushHistoryProfile[]> {
  const requestedRuntimeRoot = path.join(
    resolveManagedHadamardHome(options),
    'external-cli-profiles',
    'crush',
  );
  // resolveDirectory already rejects symlinks via lstat. Do not compare the
  // realpathed result against the lexical request path: on Windows, native
  // realpath expands 8.3 short names (RUNNER~1 → runneradmin) and that must
  // not look like a redirected/symlinked profile root.
  const runtimeRoot = await resolveDirectory(requestedRuntimeRoot);
  if (!runtimeRoot) return [];

  let entries: Dirent[];
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: ManagedCrushHistoryProfile[] = [];
  for (const entry of entries
    .filter(candidate =>
      candidate.isDirectory() && MANAGED_PROFILE_ID_PATTERN.test(candidate.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (profiles.length >= MAX_MANAGED_PROFILES_PER_RUNTIME) break;
    const requestedProfileRoot = path.join(runtimeRoot, entry.name);
    const profileRoot = await resolveDirectory(requestedProfileRoot);
    if (!profileRoot) continue;

    const requestedDataDir = path.join(profileRoot, 'data');
    const dataDir = await resolveDirectory(requestedDataDir);
    if (!dataDir) continue;
    profiles.push({ id: entry.name, dataDir });
  }
  return profiles;
}

function resolveManagedHadamardHome(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): string {
  return options.hadamardHomeDir?.trim()
    ? resolveHadamardHome(options.hadamardHomeDir, { inputKind: 'dataRoot' })
    : resolveHadamardHome(options.homeDir);
}

async function resolveDirectory(directory: string): Promise<string | undefined> {
  try {
    const requestedInfo = await lstat(directory);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
      return undefined;
    }
    const canonicalPath = await realpathNative(directory);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFile(filePath: string): Promise<string | undefined> {
  try {
    const requestedInfo = await lstat(filePath);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile()) {
      return undefined;
    }
    const canonicalPath = await realpathNative(filePath);
    const canonicalInfo = await lstat(canonicalPath);
    return !canonicalInfo.isSymbolicLink() && canonicalInfo.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function inspectSessionFile(
  runtime: ExternalCliRuntime,
  root: string,
  filePath: string,
): Promise<SessionFileCandidate | undefined> {
  try {
    const resolvedPath = path.resolve(filePath);
    if (!isPathInside(root, resolvedPath)) {
      return undefined;
    }
    const fileInfo = await lstat(resolvedPath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      return undefined;
    }
    return {
      runtime,
      path: resolvedPath,
      stats: fileInfo,
    };
  } catch {
    return undefined;
  }
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nestedFile of await collectJsonlFiles(entryPath)) {
        files.push(nestedFile);
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectCodewhaleSessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.isFile() && isCodewhaleSessionFileName(entry.name))
    .map(entry => path.join(directory, entry.name));
}

async function collectReasonixSessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.isFile() && isReasonixSessionFileName(entry.name))
    .map(entry => path.join(directory, entry.name));
}

function isSessionFileForRuntime(root: RootSpec, filePath: string): boolean {
  if (root.runtime === 'codewhale') {
    return path.relative(root.root, path.dirname(filePath)) === '' &&
      isCodewhaleSessionFileName(path.basename(filePath));
  }
  if (root.runtime === 'reasonix') {
    return path.relative(root.root, path.dirname(filePath)) === '' &&
      isReasonixSessionFileName(path.basename(filePath));
  }
  return path.extname(filePath).toLowerCase() === '.jsonl';
}

function isCodewhaleSessionFileName(fileName: string): boolean {
  return /^[A-Za-z0-9_-]+\.json$/u.test(fileName);
}

function isReasonixSessionFileName(fileName: string): boolean {
  return /^[^\\/\u0000-\u001f\u007f]+\.jsonl$/iu.test(fileName) &&
    !/(?:^|\.)(?:events|guardian)\.jsonl$/iu.test(fileName);
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function unsafeSessionPath(filePath: string): HadamardSdkError {
  return new HadamardSdkError(
    `External CLI session path is outside the allowed roots: ${filePath}`,
    'EXTERNAL_CLI_SESSION_PATH_UNSAFE',
  );
}

async function parseSessionFile(
  runtime: ExternalCliRuntime,
  filePath: string,
  bounds: ParseBounds,
  knownFileInfo?: Stats,
): Promise<ExternalCliSession | undefined> {
  let fileInfo: Stats;
  try {
    fileInfo = knownFileInfo ?? await stat(filePath);
  } catch {
    return undefined;
  }

  if (runtime === 'codewhale') {
    return parseCodewhaleSessionFile(filePath, bounds, fileInfo);
  }
  if (runtime === 'reasonix') {
    return parseReasonixSessionFile(filePath, bounds, fileInfo);
  }

  const state: ParseState = {
    messages: [],
    fallbackMessages: [],
    piEntries: [],
    piMessageCount: 0,
  };

  let truncated: boolean;
  try {
    truncated = await scanSessionFile(runtime, filePath, fileInfo, state, bounds);
  } catch {
    return undefined;
  }

  if (runtime === 'pi') {
    finalizePiState(state);
  }

  const messages = runtime === 'codex' && !hasConversationMessages(state.messages)
    ? state.fallbackMessages
    : state.messages;
  const nativeSessionId = state.nativeSessionId ?? sessionIdFromFileName(filePath);
  const firstUserText = messages.find(message => message.role === 'user' && message.text)?.text;
  const firstAssistantText = messages.find(
    message => message.role === 'assistant' && message.text,
  )?.text;
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const created = state.earliestTimestamp ?? fallbackCreated;
  const updated = truncated
    ? Math.max(state.latestTimestamp ?? 0, fileInfo.mtimeMs)
    : state.latestTimestamp ?? fileInfo.mtimeMs;

  const summary: ExternalCliSessionSummary = {
    runtime,
    nativeSessionId,
    title: normalizeTitle(state.nativeTitle ?? firstUserText ?? firstAssistantText ?? nativeSessionId),
    cwd: state.cwd,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    messageCount: messages.length,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };

  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function parseReasonixSessionFile(
  filePath: string,
  bounds: ParseBounds,
  fileInfo: Stats,
): Promise<ExternalCliSession | undefined> {
  const metadata = await readReasonixMetadataSidecar(filePath);
  if (fileInfo.size === 0 && !metadata) {
    return undefined;
  }

  const bytesToRead = Math.min(fileInfo.size, bounds.maxBytes);
  let source = '';
  if (bytesToRead > 0) {
    try {
      source = await readBoundedUtf8File(filePath, bytesToRead);
    } catch {
      return undefined;
    }
  }

  const parsed = parseReasonixSessionJsonl(source, {
    filePath,
    metadata,
    fileCreatedAt: fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs,
    fileUpdatedAt: fileInfo.mtimeMs,
    maxRecords: bounds.maxMessages * 2,
    maxMessages: bounds.maxMessages,
    maxRecordChars: bounds.maxBytes,
    maxTextChars: bounds.maxBytes,
    maxToolPayloadChars: Math.min(bounds.maxBytes, 64 * 1024),
  });
  if (parsed.messageCount === 0 && !metadata) {
    return undefined;
  }

  const messages = parsed.messages.map(normalizeReasonixMessage);
  const nativeSessionId = parsed.nativeSessionId ?? sessionIdFromFileName(filePath);
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const truncated = fileInfo.size > bytesToRead || parsed.truncated;
  const parsedUpdatedAt = parsed.updatedAt ? Date.parse(parsed.updatedAt) : Number.NaN;
  const updatedAt = truncated
    ? new Date(Math.max(
        Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
        fileInfo.mtimeMs,
      )).toISOString()
    : parsed.updatedAt ?? new Date(fileInfo.mtimeMs).toISOString();
  const summary: ExternalCliSessionSummary = {
    runtime: 'reasonix',
    nativeSessionId,
    title: normalizeTitle(parsed.title ?? nativeSessionId),
    cwd: parsed.cwd,
    createdAt: parsed.createdAt ?? new Date(fallbackCreated).toISOString(),
    updatedAt,
    messageCount: parsed.messageCount,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };
  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function readReasonixMetadataSidecar(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  const parent = path.dirname(filePath);
  for (const sidecarPath of [`${stem}.acp.json`, `${stem}.meta.json`]) {
    const canonicalPath = await resolveFile(sidecarPath);
    if (!canonicalPath) {
      continue;
    }
    const relative = path.relative(parent, canonicalPath);
    if (!relative || path.dirname(relative) !== '.' || path.isAbsolute(relative)) {
      continue;
    }

    let sidecarInfo: Stats;
    try {
      sidecarInfo = await stat(canonicalPath);
    } catch {
      continue;
    }
    if (sidecarInfo.size === 0 || sidecarInfo.size > MAX_REASONIX_METADATA_BYTES) {
      continue;
    }

    try {
      const source = await readBoundedUtf8File(canonicalPath, sidecarInfo.size);
      const parsed = JSON.parse(source) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // A corrupt current sidecar may still have a usable legacy fallback.
    }
  }
  return undefined;
}

function normalizeReasonixMessage(
  message: ReasonixSessionMessage,
): ExternalCliSessionMessage {
  const role: ExternalCliSessionRole = message.role === 'think'
    ? 'assistant'
    : message.role;
  return {
    role,
    text: message.text,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.tools?.length
      ? { tools: message.tools.map(tool => ({ ...tool })) }
      : {}),
  };
}

async function parseCodewhaleSessionFile(
  filePath: string,
  bounds: ParseBounds,
  fileInfo: Stats,
): Promise<ExternalCliSession | undefined> {
  const savedSessionPrefix = await readCodewhaleSavedSessionPrefix(
    filePath,
    fileInfo,
    bounds.maxBytes,
  );
  if (!savedSessionPrefix) {
    return undefined;
  }
  const { bytesToRead, metadata, savedSession, source } = savedSessionPrefix;

  const rawMessages = savedSession && Array.isArray(savedSession.messages)
    ? savedSession.messages.slice(0, bounds.maxMessages + 1)
    : extractCodewhaleMessages(source, bounds.maxMessages + 1);
  const stoppedForMessageLimit = rawMessages.length > bounds.maxMessages;
  const messages: ExternalCliSessionMessage[] = [];
  const model = stringValue(metadata.model);
  for (const rawMessage of rawMessages.slice(0, bounds.maxMessages)) {
    if (isRecord(rawMessage)) {
      consumeCodewhaleMessage(rawMessage, model, messages);
    }
  }

  const nativeSessionId = stringValue(metadata.id) ?? sessionIdFromFileName(filePath);
  const firstUserText = messages.find(message => message.role === 'user' && message.text)?.text;
  const firstAssistantText = messages.find(
    message => message.role === 'assistant' && message.text,
  )?.text;
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const createdAt = normalizeTimestamp(metadata.created_at)
    ?? new Date(fallbackCreated).toISOString();
  const updatedAt = normalizeTimestamp(metadata.updated_at)
    ?? new Date(fileInfo.mtimeMs).toISOString();
  const truncated = fileInfo.size > bytesToRead || stoppedForMessageLimit;
  const summary: ExternalCliSessionSummary = {
    runtime: 'codewhale',
    nativeSessionId,
    title: normalizeTitle(
      stringValue(metadata.title) ?? firstUserText ?? firstAssistantText ?? nativeSessionId,
    ),
    cwd: stringValue(metadata.workspace),
    createdAt,
    updatedAt,
    messageCount: nonNegativeIntegerValue(metadata.message_count) ?? messages.length,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };
  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function readCodewhaleSavedSessionPrefix(
  filePath: string,
  fileInfo: Stats,
  maxBytes: number,
): Promise<CodewhaleSavedSessionPrefix | undefined> {
  if (fileInfo.size === 0) {
    return undefined;
  }

  const bytesToRead = Math.min(fileInfo.size, maxBytes);
  let source: string;
  try {
    source = await readBoundedUtf8File(filePath, bytesToRead);
  } catch {
    return undefined;
  }

  let savedSession: Record<string, unknown> | undefined;
  if (fileInfo.size <= bytesToRead) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      savedSession = parsed;
    } catch {
      return undefined;
    }
  }

  const metadata = savedSession && isRecord(savedSession.metadata)
    ? savedSession.metadata
    : extractCodewhaleMetadata(source);
  return metadata ? { source, savedSession, metadata, bytesToRead } : undefined;
}

async function readBoundedUtf8File(filePath: string, maxBytes: number): Promise<string> {
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: maxBytes - 1,
    highWaterMark: 64 * 1024,
  });
  let source = '';
  try {
    for await (const chunk of stream) {
      source += chunk;
    }
    return source;
  } finally {
    stream.destroy();
  }
}

function extractCodewhaleMetadata(source: string): Record<string, unknown> | undefined {
  const valueStart = findTopLevelJsonPropertyValueStart(source, 'metadata');
  if (valueStart == null || source[valueStart] !== '{') {
    return undefined;
  }
  const valueEnd = findJsonCompositeEnd(source, valueStart);
  if (valueEnd == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source.slice(valueStart, valueEnd)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractCodewhaleMessages(source: string, limit: number): unknown[] {
  const arrayStart = findTopLevelJsonPropertyValueStart(source, 'messages');
  if (arrayStart == null || source[arrayStart] !== '[') {
    return [];
  }

  const messages: unknown[] = [];
  let cursor = arrayStart + 1;
  while (messages.length < limit) {
    while (cursor < source.length && /[\s,]/u.test(source[cursor]!)) {
      cursor += 1;
    }
    if (source[cursor] === ']' || source[cursor] !== '{') {
      break;
    }
    const valueEnd = findJsonCompositeEnd(source, cursor);
    if (valueEnd == null) {
      break;
    }
    try {
      messages.push(JSON.parse(source.slice(cursor, valueEnd)) as unknown);
    } catch {
      break;
    }
    cursor = valueEnd;
  }
  return messages;
}

function findTopLevelJsonPropertyValueStart(
  source: string,
  propertyName: string,
): number | undefined {
  let depth = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(source, cursor);
      if (stringEnd == null) {
        return undefined;
      }
      if (depth === 1) {
        let separator = stringEnd + 1;
        while (separator < source.length && /\s/u.test(source[separator]!)) {
          separator += 1;
        }
        if (source[separator] === ':') {
          try {
            const key = JSON.parse(source.slice(cursor, stringEnd + 1)) as unknown;
            if (key === propertyName) {
              separator += 1;
              while (separator < source.length && /\s/u.test(source[separator]!)) {
                separator += 1;
              }
              return separator;
            }
          } catch {
            return undefined;
          }
        }
      }
      cursor = stringEnd + 1;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
    cursor += 1;
  }
  return undefined;
}

function findJsonCompositeEnd(source: string, start: number): number | undefined {
  const opening = source[start];
  if (opening !== '{' && opening !== '[') {
    return undefined;
  }
  const stack: string[] = [opening];
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(source, cursor);
      if (stringEnd == null) {
        return undefined;
      }
      cursor = stringEnd + 1;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expectedOpening = character === '}' ? '{' : '[';
      if (stack.pop() !== expectedOpening) {
        return undefined;
      }
      if (stack.length === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return undefined;
}

function findJsonStringEnd(source: string, start: number): number | undefined {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') {
      return cursor;
    }
    cursor += 1;
  }
  return undefined;
}

function consumeCodewhaleMessage(
  message: Record<string, unknown>,
  model: string | undefined,
  messages: ExternalCliSessionMessage[],
): void {
  const role = normalizeRole(message.role);
  if (!role) {
    return;
  }
  const content = extractCodewhaleContent(message.content);
  pushMessage(messages, {
    role: content.toolResultOnly ? 'tool' : role,
    text: content.text,
    model,
    tools: content.tools,
  });
}

function extractCodewhaleContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') {
    return { text: content.trim(), tools: [], toolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', tools: [], toolResultOnly: false };
  }

  const textParts: string[] = [];
  const tools: ExternalCliToolMetadata[] = [];
  let hasPlainText = false;
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = stringValue(block.type);
    if (type === 'text' || type === 'thinking') {
      const text = stringValue(type === 'thinking' ? block.thinking : block.text);
      if (text) {
        textParts.push(text);
        hasPlainText = true;
      }
      continue;
    }
    if (type === 'tool_use' || type === 'server_tool_use') {
      tools.push({
        kind: 'call',
        id: stringValue(block.id),
        name: stringValue(block.name),
        input: block.input,
      });
      continue;
    }
    if (type === 'tool_result') {
      const output = visibleText(block.content) || visibleText(block.content_blocks);
      tools.push({
        kind: 'result',
        id: stringValue(block.tool_use_id),
        output,
        isError: booleanValue(block.is_error),
      });
      if (output) {
        textParts.push(output);
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    tools,
    toolResultOnly: tools.some(tool => tool.kind === 'result') && !hasPlainText,
  };
}

async function scanSessionFile(
  runtime: ExternalCliRuntime,
  filePath: string,
  fileInfo: Stats,
  state: ParseState,
  bounds: ParseBounds,
): Promise<boolean> {
  if (fileInfo.size === 0) {
    return false;
  }

  const bytesToRead = Math.min(fileInfo.size, bounds.maxBytes);
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: bytesToRead - 1,
    highWaterMark: 64 * 1024,
  });
  let pending = '';
  let stoppedForMessageLimit = false;

  try {
    scan: for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/u, '');
        pending = pending.slice(newlineIndex + 1);
        consumeSessionLine(runtime, line, state);
        if (parsedMessageCount(runtime, state) >= bounds.maxMessages) {
          stoppedForMessageLimit = true;
          break scan;
        }
        newlineIndex = pending.indexOf('\n');
      }
    }

    const stoppedForByteLimit = fileInfo.size > bytesToRead;
    if (!stoppedForByteLimit && !stoppedForMessageLimit && pending.trim()) {
      consumeSessionLine(runtime, pending.replace(/\r$/u, ''), state);
    }
    return stoppedForByteLimit || stoppedForMessageLimit;
  } finally {
    stream.destroy();
  }
}

function consumeSessionLine(
  runtime: ExternalCliRuntime,
  line: string,
  state: ParseState,
): void {
  if (!line.trim()) {
    return;
  }
  try {
    const record = JSON.parse(line) as unknown;
    if (!isRecord(record)) {
      return;
    }
    if (runtime === 'claude') {
      consumeClaudeRecord(record, state);
    } else if (runtime === 'codex') {
      consumeCodexRecord(record, state);
    } else if (runtime === 'pi') {
      consumePiRecord(record, state);
    }
  } catch {
    // A CLI can be terminated while appending its final JSONL record.
  }
}

function parsedMessageCount(runtime: ExternalCliRuntime, state: ParseState): number {
  if (runtime === 'pi') {
    return state.piMessageCount;
  }
  return hasConversationMessages(state.messages)
    ? state.messages.length
    : state.fallbackMessages.length;
}

function getCachedSummary(
  candidate: SessionFileCandidate,
  bounds: ParseBounds,
): ExternalCliSessionSummary | undefined {
  const cached = summaryCache.get(candidate.path);
  if (
    !cached ||
    cached.runtime !== candidate.runtime ||
    cached.mtimeMs !== candidate.stats.mtimeMs ||
    cached.size !== candidate.stats.size ||
    cached.maxBytes !== bounds.maxBytes ||
    cached.maxMessages !== bounds.maxMessages
  ) {
    return undefined;
  }
  summaryCache.delete(candidate.path);
  summaryCache.set(candidate.path, cached);
  return { ...cached.summary };
}

function cacheSummary(
  candidate: SessionFileCandidate,
  bounds: ParseBounds,
  summary: ExternalCliSessionSummary,
): void {
  summaryCache.delete(candidate.path);
  summaryCache.set(candidate.path, {
    runtime: candidate.runtime,
    mtimeMs: candidate.stats.mtimeMs,
    size: candidate.stats.size,
    maxBytes: bounds.maxBytes,
    maxMessages: bounds.maxMessages,
    summary: { ...summary },
  });
  while (summaryCache.size > MAX_SUMMARY_CACHE_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    summaryCache.delete(oldestKey);
  }
}

function normalizedNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function consumeClaudeRecord(record: Record<string, unknown>, state: ParseState): void {
  const timestamp = rememberTimestamp(state, record.timestamp);
  state.nativeSessionId ??= stringValue(record.sessionId);
  state.cwd ??= stringValue(record.cwd);

  if (record.type === 'summary') {
    state.nativeTitle ??= stringValue(record.summary);
    return;
  }

  if (record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system') {
    return;
  }

  const message = isRecord(record.message) ? record.message : record;
  const role = normalizeRole(message.role) ?? normalizeRole(record.type);
  if (!role) {
    return;
  }

  const content = extractContent(message.content);
  const normalizedRole = content.toolResultOnly ? 'tool' : role;
  pushMessage(state.messages, {
    role: normalizedRole,
    text: content.text,
    timestamp,
    model: stringValue(message.model),
    tools: content.tools,
  });
}

function consumeCodexRecord(record: Record<string, unknown>, state: ParseState): void {
  const timestamp = rememberTimestamp(state, record.timestamp);
  const payload = isRecord(record.payload) ? record.payload : undefined;
  if (!payload) {
    return;
  }

  if (record.type === 'session_meta') {
    state.nativeSessionId ??= stringValue(payload.id);
    state.cwd ??= stringValue(payload.cwd);
    rememberTimestamp(state, payload.timestamp);
    return;
  }

  if (record.type === 'turn_context') {
    state.cwd ??= stringValue(payload.cwd);
    state.model = stringValue(payload.model) ?? state.model;
    return;
  }

  if (record.type === 'response_item') {
    consumeCodexResponseItem(payload, state, timestamp);
    return;
  }

  if (record.type === 'event_msg') {
    consumeCodexEventMessage(payload, state, timestamp);
  }
}

function consumeCodexResponseItem(
  payload: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  if (payload.type === 'message') {
    const role = normalizeRole(payload.role);
    if (!role) {
      return;
    }
    const content = extractContent(payload.content);
    pushMessage(state.messages, {
      role: content.toolResultOnly ? 'tool' : role,
      text: content.text,
      timestamp,
      model: stringValue(payload.model) ?? state.model,
      tools: content.tools,
    });
    return;
  }

  const tool = codexToolMetadata(payload);
  if (!tool) {
    return;
  }
  pushMessage(state.messages, {
    role: tool.kind === 'result' ? 'tool' : 'assistant',
    text: tool.output ?? '',
    timestamp,
    model: state.model,
    tools: [tool],
  });
}

function consumeCodexEventMessage(
  payload: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  const role = payload.type === 'user_message'
    ? 'user'
    : payload.type === 'agent_message'
      ? 'assistant'
      : undefined;
  if (!role) {
    return;
  }
  pushMessage(state.fallbackMessages, {
    role,
    text: visibleText(payload.message),
    timestamp,
    model: stringValue(payload.model) ?? state.model,
  });
}

function consumePiRecord(record: Record<string, unknown>, state: ParseState): void {
  rememberTimestamp(state, record.timestamp);

  if (record.type === 'session') {
    state.nativeSessionId ??= stringValue(record.id);
    state.cwd ??= stringValue(record.cwd);
    return;
  }

  const id = stringValue(record.id);
  const parentId = record.parentId === null ? null : stringValue(record.parentId);
  if (!id || parentId === undefined) {
    return;
  }

  state.piEntries.push({ id, parentId, record });
  if (record.type === 'message' && isRecord(record.message)) {
    const role = record.message.role;
    if (role === 'user' || role === 'assistant' || role === 'toolResult') {
      state.piMessageCount += 1;
    }
  }
}

function finalizePiState(state: ParseState): void {
  state.messages = [];
  state.nativeTitle = undefined;
  state.model = undefined;

  const entriesById = new Map(state.piEntries.map(entry => [entry.id, entry]));
  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let entry = state.piEntries.at(-1);

  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    branch.push(entry);
    entry = entry.parentId === null ? undefined : entriesById.get(entry.parentId);
  }

  branch.reverse();
  for (const branchEntry of branch) {
    const record = branchEntry.record;
    if (record.type === 'session_info') {
      state.nativeTitle = stringValue(record.name) ?? state.nativeTitle;
      continue;
    }
    if (record.type === 'model_change') {
      state.model = stringValue(record.modelId) ?? state.model;
      continue;
    }
    if (record.type === 'message' && isRecord(record.message)) {
      consumePiMessage(record.message, state, normalizeTimestamp(record.timestamp));
    }
  }
}

function consumePiMessage(
  message: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  const content = extractContent(message.content);
  if (message.role === 'user' || message.role === 'assistant') {
    pushMessage(state.messages, {
      role: message.role,
      text: content.text,
      timestamp,
      model: stringValue(message.model) ?? state.model,
      tools: content.tools,
    });
    return;
  }

  if (message.role === 'toolResult') {
    pushMessage(state.messages, {
      role: 'tool',
      text: content.text,
      timestamp,
      model: state.model,
      tools: [{
        kind: 'result',
        id: stringValue(message.toolCallId ?? message.tool_call_id),
        name: stringValue(message.toolName ?? message.tool_name),
        output: content.text,
        isError: booleanValue(message.isError ?? message.is_error),
      }],
    });
  }
}

function codexToolMetadata(payload: Record<string, unknown>): ExternalCliToolMetadata | undefined {
  const type = stringValue(payload.type);
  if (!type) {
    return undefined;
  }

  if (type.endsWith('_output') || type.endsWith('_result')) {
    const output = visibleText(payload.output ?? payload.result);
    return {
      kind: 'result',
      id: stringValue(payload.call_id ?? payload.id),
      output,
      isError: booleanValue(payload.is_error ?? payload.isError),
    };
  }

  if (type.endsWith('_call') || type === 'local_shell_call') {
    return {
      kind: 'call',
      id: stringValue(payload.call_id ?? payload.id),
      name: stringValue(payload.name) ?? type.replace(/_call$/u, ''),
      input: payload.arguments ?? payload.input ?? payload.command,
    };
  }

  return undefined;
}

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') {
    return { text: content.trim(), tools: [], toolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', tools: [], toolResultOnly: false };
  }

  const textParts: string[] = [];
  const tools: ExternalCliToolMetadata[] = [];
  let hasPlainText = false;

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = stringValue(block.type);
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = stringValue(block.text);
      if (text) {
        textParts.push(text);
        hasPlainText = true;
      }
      continue;
    }
    if (
      type === 'tool_use' ||
      type === 'function_call' ||
      type === 'custom_tool_call' ||
      type === 'toolCall'
    ) {
      tools.push({
        kind: 'call',
        id: stringValue(block.id ?? block.call_id),
        name: stringValue(block.name),
        input: block.input ?? block.arguments,
      });
      continue;
    }
    if (type === 'tool_result' || type === 'function_call_output') {
      const output = visibleText(block.content ?? block.output);
      tools.push({
        kind: 'result',
        id: stringValue(block.tool_use_id ?? block.call_id ?? block.id),
        output,
        isError: booleanValue(block.is_error ?? block.isError),
      });
      if (output) {
        textParts.push(output);
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    tools,
    toolResultOnly: tools.some(tool => tool.kind === 'result') && !hasPlainText,
  };
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(visibleText).filter(Boolean).join('\n').trim();
  }
  if (!isRecord(value)) {
    return '';
  }
  if (
    (value.type === 'text' || value.type === 'input_text' || value.type === 'output_text') &&
    typeof value.text === 'string'
  ) {
    return value.text.trim();
  }
  return visibleText(value.content);
}

function pushMessage(
  messages: ExternalCliSessionMessage[],
  message: ExternalCliSessionMessage,
): void {
  const tools = message.tools?.filter(Boolean);
  if (!message.text && !tools?.length) {
    return;
  }
  messages.push({
    ...message,
    ...(tools?.length ? { tools } : { tools: undefined }),
  });
}

function hasConversationMessages(messages: ExternalCliSessionMessage[]): boolean {
  return messages.some(message =>
    Boolean(message.text) && (message.role === 'user' || message.role === 'assistant'),
  );
}

function rememberTimestamp(state: ParseState, value: unknown): string | undefined {
  const timestamp = normalizeTimestamp(value);
  if (timestamp) {
    const milliseconds = Date.parse(timestamp);
    state.earliestTimestamp = state.earliestTimestamp == null
      ? milliseconds
      : Math.min(state.earliestTimestamp, milliseconds);
    state.latestTimestamp = state.latestTimestamp == null
      ? milliseconds
      : Math.max(state.latestTimestamp, milliseconds);
  }
  return timestamp;
}

function normalizeTimestamp(value: unknown): string | undefined {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return undefined;
  }
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function sessionIdFromFileName(filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  return fileName.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu)?.[1] ?? fileName;
}

function normalizeRole(value: unknown): ExternalCliSessionRole | undefined {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value;
  }
  return value === 'developer' ? 'system' : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
