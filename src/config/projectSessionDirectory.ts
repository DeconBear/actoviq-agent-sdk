import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveHadamardHome } from './hadamardHome.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';

const MAX_PROJECT_KEY_LENGTH = 200;
const PROJECT_KEY_HASH_LENGTH = 24;
const PROJECT_KEY_SEPARATOR = '--';
const MAX_PROJECT_KEY_PREFIX_LENGTH =
  MAX_PROJECT_KEY_LENGTH - PROJECT_KEY_SEPARATOR.length - PROJECT_KEY_HASH_LENGTH;
const RETAINED_PROJECT_ARTIFACTS = new Set([
  'meta.json',
  'workspace-note.txt',
  'rail-items.json',
  'issues.json',
  'plan.json',
  'PROGRESS.md',
  'manager.json',
  'terminals',
  'mailboxes',
  'teammates',
]);

interface StoredJsonFile {
  fileName: string;
  storageId: string;
  value: Record<string, unknown>;
}

interface StoredJsonDirectory {
  entries: StoredJsonFile[];
  hasUnassignedJson: boolean;
}

interface StoredSessionFile extends StoredJsonFile {
  sessionId: string;
  parentSessionId?: string;
  metadataWorkDir?: string;
  worktreePath?: string;
  workDirs: string[];
}

interface StoredExecutionFile extends StoredJsonFile {
  executionIds: string[];
  sessionIds: string[];
  workDir?: string;
}

interface StoredTaskFile extends StoredJsonFile {
  executionId?: string;
  parentSessionId?: string;
  sessionId?: string;
  workDir?: string;
  worktreePath?: string;
}

export interface HadamardProjectDataMigrationSummary {
  sessions: number;
  archivedSessions: number;
  agentExecutions: number;
  backgroundTasks: number;
  globalSessions: number;
  projectArtifacts: number;
  /** Legacy singleton artifacts retained because they have no per-record owner metadata. */
  retainedUnassignedArtifacts: string[];
  total: number;
}

function normalizeProjectPath(workDir: string): string {
  const resolved = path.resolve(workDir).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathBelongsToProject(candidate: string, projectRoot: string): boolean {
  const normalizedCandidate = normalizeProjectPath(candidate);
  const normalizedRoot = normalizeProjectPath(projectRoot);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function encodeLegacyHadamardProjectPath(workDir: string): string {
  const resolved = path.resolve(workDir).normalize('NFC');
  const sanitized = resolved.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_PROJECT_KEY_LENGTH) {
    return sanitized;
  }
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return `${sanitized.slice(0, MAX_PROJECT_KEY_LENGTH)}-${hash}`;
}

export function encodeHadamardProjectPath(workDir: string): string {
  const normalized = normalizeProjectPath(workDir);
  const readablePrefix = normalized
    .replace(/[^a-zA-Z0-9]/g, '-')
    .slice(0, MAX_PROJECT_KEY_PREFIX_LENGTH);
  const hash = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, PROJECT_KEY_HASH_LENGTH);
  return `${readablePrefix}${PROJECT_KEY_SEPARATOR}${hash}`;
}

export function getHadamardProjectSessionDirectory(
  workDir: string,
  homeDir: string,
): string {
  return path.join(resolveHadamardHome(homeDir), 'projects', encodeHadamardProjectPath(workDir));
}

function legacyProjectDirectory(workDir: string, homeDir: string): string {
  return path.join(
    resolveHadamardHome(homeDir),
    'projects',
    encodeLegacyHadamardProjectPath(workDir),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function jsonStorageId(fileName: string): string | undefined {
  if (!fileName.endsWith('.json')) {
    return undefined;
  }
  try {
    return assertSafeStorageSegment(
      'legacy JSON storage id',
      fileName.slice(0, -'.json'.length),
    );
  } catch {
    return undefined;
  }
}

function sessionWorkDirs(value: Record<string, unknown>): string[] {
  const metadataWorkDir = isRecord(value.metadata)
    ? nonEmptyString(value.metadata.__hadamardWorkDir)
    : undefined;
  return [
    metadataWorkDir,
    nonEmptyString(value.originalWorkDir),
  ].filter((entry): entry is string => entry !== undefined);
}

async function readStoredJsonFiles(directory: string): Promise<StoredJsonDirectory> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], hasUnassignedJson: false };
    }
    throw error;
  }

  const entries: StoredJsonFile[] = [];
  let hasUnassignedJson = false;
  for (const fileName of files.sort()) {
    if (!fileName.endsWith('.json')) {
      continue;
    }
    const storageId = jsonStorageId(fileName);
    if (!storageId) {
      hasUnassignedJson = true;
      continue;
    }
    try {
      const value = JSON.parse(
        await readFile(path.join(directory, fileName), 'utf8'),
      ) as unknown;
      if (!isRecord(value)) {
        hasUnassignedJson = true;
        continue;
      }
      entries.push({
        fileName,
        storageId,
        value,
      });
    } catch {
      // Keep unreadable source files in place for manual recovery.
      hasUnassignedJson = true;
    }
  }
  return { entries, hasUnassignedJson };
}

function asSessionFile(entry: StoredJsonFile): StoredSessionFile {
  const metadata = isRecord(entry.value.metadata)
    ? entry.value.metadata
    : undefined;
  return {
    ...entry,
    sessionId: nonEmptyString(entry.value.id) ?? entry.storageId,
    parentSessionId: nonEmptyString(entry.value.parentSessionId),
    metadataWorkDir: metadata
      ? nonEmptyString(metadata.__hadamardWorkDir)
      : undefined,
    worktreePath: metadata
      ? nonEmptyString(metadata.__hadamardAgentWorktreePath)
      : undefined,
    workDirs: sessionWorkDirs(entry.value),
  };
}

function sessionUsesDeclaredWorktree(entry: StoredSessionFile): boolean {
  return entry.metadataWorkDir !== undefined &&
    entry.worktreePath !== undefined &&
    samePath(entry.metadataWorkDir, entry.worktreePath);
}

function selectProjectSessions(
  entries: StoredSessionFile[],
  workDir: string,
): StoredSessionFile[] {
  const selected = new Set<StoredSessionFile>();
  const entriesBySessionId = new Map<string, StoredSessionFile[]>();
  for (const entry of entries) {
    const matches = entriesBySessionId.get(entry.sessionId) ?? [];
    matches.push(entry);
    entriesBySessionId.set(entry.sessionId, matches);
  }
  for (const entry of entries) {
    if (entry.workDirs.some(entryWorkDir => samePath(entryWorkDir, workDir))) {
      selected.add(entry);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (
        selected.has(entry) ||
        !entry.parentSessionId
      ) {
        continue;
      }
      const parentEntries = entriesBySessionId.get(entry.parentSessionId) ?? [];
      if (
        parentEntries.length === 0 ||
        parentEntries.some(parentEntry => !selected.has(parentEntry))
      ) {
        continue;
      }
      if (entry.workDirs.length > 0 && !sessionUsesDeclaredWorktree(entry)) {
        continue;
      }
      selected.add(entry);
      changed = true;
    }
  }
  return entries.filter(entry => selected.has(entry));
}

function uniquelySelectedIds<T>(
  entries: readonly T[],
  selectedEntries: ReadonlySet<T>,
  idsOf: (entry: T) => readonly string[],
): Set<string> {
  const entriesById = new Map<string, T[]>();
  for (const entry of entries) {
    for (const id of idsOf(entry)) {
      const matches = entriesById.get(id) ?? [];
      matches.push(entry);
      entriesById.set(id, matches);
    }
  }
  return new Set(
    [...entriesById.entries()]
      .filter(([, matches]) => matches.every(entry => selectedEntries.has(entry)))
      .map(([id]) => id),
  );
}

function asExecutionFile(entry: StoredJsonFile): StoredExecutionFile {
  const rootExecutionId = nonEmptyString(entry.value.rootExecutionId);
  const rawNodes = Array.isArray(entry.value.nodes)
    ? entry.value.nodes
    : Array.isArray(entry.value.executions)
      ? entry.value.executions
      : [];
  const nodes = rawNodes.filter(isRecord);
  const rootNode = nodes.find(node => nonEmptyString(node.id) === rootExecutionId) ??
    nodes.find(node => node.kind === 'root');
  return {
    ...entry,
    executionIds: nodes.flatMap(node => {
      const id = nonEmptyString(node.id);
      return id ? [id] : [];
    }),
    sessionIds: nodes.flatMap(node => {
      const sessionId = nonEmptyString(node.sessionId);
      return sessionId ? [sessionId] : [];
    }),
    workDir: rootNode ? nonEmptyString(rootNode.cwd) : undefined,
  };
}

function asTaskFile(entry: StoredJsonFile): StoredTaskFile {
  return {
    ...entry,
    executionId:
      nonEmptyString(entry.value.executionId) ??
      nonEmptyString(entry.value.executionNodeId),
    parentSessionId: nonEmptyString(entry.value.parentSessionId),
    sessionId: nonEmptyString(entry.value.sessionId),
    workDir: nonEmptyString(entry.value.workDir),
    worktreePath: nonEmptyString(entry.value.worktreePath),
  };
}

async function copyFileIfMissing(source: string, target: string): Promise<boolean> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function copyCheckpoints(
  sourceDirectory: string,
  targetDirectory: string,
  storageId: string,
): Promise<void> {
  try {
    await cp(
      path.join(sourceDirectory, '.checkpoints', storageId),
      path.join(targetDirectory, '.checkpoints', storageId),
      {
        recursive: true,
        errorOnExist: false,
        force: false,
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ERR_FS_CP_EEXIST') {
      throw error;
    }
  }
}

async function copySessionFiles(
  entries: StoredSessionFile[],
  sourceDirectory: string,
  targetDirectory: string,
  workDir: string,
): Promise<number> {
  let copied = 0;
  for (const entry of entries) {
    const targetFile = path.join(targetDirectory, entry.fileName);
    const sessionCopied = await copyFileIfMissing(
      path.join(sourceDirectory, entry.fileName),
      targetFile,
    );
    if (sessionCopied) {
      copied += 1;
    }
    if (
      sessionCopied ||
      await storedSessionBelongsToProject(targetFile, workDir) ||
      await filesHaveSameContents(
        path.join(sourceDirectory, entry.fileName),
        targetFile,
      )
    ) {
      await copyCheckpoints(sourceDirectory, targetDirectory, entry.storageId);
    }
  }
  return copied;
}

async function storedSessionBelongsToProject(
  filePath: string,
  workDir: string,
): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return isRecord(value) &&
      sessionWorkDirs(value).some(entryWorkDir => samePath(entryWorkDir, workDir));
  } catch {
    return false;
  }
}

async function filesHaveSameContents(left: string, right: string): Promise<boolean> {
  try {
    const [leftContent, rightContent] = await Promise.all([
      readFile(left),
      readFile(right),
    ]);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

async function copyStoredJsonFiles(
  entries: StoredJsonFile[],
  sourceDirectory: string,
  targetDirectory: string,
): Promise<number> {
  let copied = 0;
  for (const entry of entries) {
    if (
      await copyFileIfMissing(
        path.join(sourceDirectory, entry.fileName),
        path.join(targetDirectory, entry.fileName),
      )
    ) {
      copied += 1;
    }
  }
  return copied;
}

async function registeredLegacyProjectPaths(
  homeDir: string,
  legacyKey: string,
): Promise<string[]> {
  const comparableLegacyKey = process.platform === 'win32'
    ? legacyKey.toLowerCase()
    : legacyKey;
  try {
    const raw = JSON.parse(
      await readFile(path.join(resolveHadamardHome(homeDir), 'workspaces.json'), 'utf8'),
    ) as unknown;
    const entries = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.workspaces)
        ? raw.workspaces
        : [];
    const paths = entries.flatMap(entry => {
      if (!isRecord(entry)) return [];
      const workDir = nonEmptyString(entry.path);
      const candidateLegacyKey = workDir
        ? encodeLegacyHadamardProjectPath(workDir)
        : undefined;
      if (
        !workDir ||
        (process.platform === 'win32'
          ? candidateLegacyKey?.toLowerCase()
          : candidateLegacyKey) !== comparableLegacyKey
      ) return [];
      return [path.resolve(workDir)];
    });
    return [...new Map(paths.map(workDir => [normalizeProjectPath(workDir), workDir])).values()];
  } catch {
    return [];
  }
}

function hasExplicitOtherSessionOwner(
  entries: StoredSessionFile[],
  workDir: string,
  selectedEntries: ReadonlySet<StoredSessionFile>,
): boolean {
  return entries.some(entry =>
    !selectedEntries.has(entry) &&
    entry.workDirs.length > 0 &&
    !entry.workDirs.some(entryWorkDir => samePath(entryWorkDir, workDir))
  );
}

async function legacyArtifactsBelongToProject(options: {
  homeDir: string;
  workDir: string;
  legacyDirectory: string;
  sessionEntries: StoredSessionFile[];
  selectedSessions: ReadonlySet<StoredSessionFile>;
  executionEntries: StoredExecutionFile[];
  selectedExecutions: readonly StoredExecutionFile[];
  taskEntries: StoredTaskFile[];
  selectedTasks: readonly StoredTaskFile[];
  hasUnassignedJson: boolean;
}): Promise<boolean> {
  if (options.hasUnassignedJson) {
    return false;
  }
  const selectedExecutionSet = new Set(options.selectedExecutions);
  const selectedTaskSet = new Set(options.selectedTasks);
  const hasOtherOwner =
    hasExplicitOtherSessionOwner(
      options.sessionEntries,
      options.workDir,
      options.selectedSessions,
    ) ||
    options.executionEntries.some(entry =>
      !selectedExecutionSet.has(entry) &&
      entry.workDir !== undefined &&
      !pathBelongsToProject(entry.workDir, options.workDir)
    ) ||
    options.taskEntries.some(entry =>
      !selectedTaskSet.has(entry) &&
      entry.workDir !== undefined &&
      !pathBelongsToProject(entry.workDir, options.workDir)
    );
  if (hasOtherOwner) {
    return false;
  }

  const legacyKey = path.basename(options.legacyDirectory);
  const registeredPaths = await registeredLegacyProjectPaths(options.homeDir, legacyKey);
  if (registeredPaths.some(registered => !samePath(registered, options.workDir))) {
    return false;
  }
  const hasProjectEvidence =
    options.selectedSessions.size > 0 ||
    options.selectedExecutions.length > 0 ||
    options.selectedTasks.length > 0 ||
    registeredPaths.some(registered => samePath(registered, options.workDir));
  return hasProjectEvidence;
}

async function copyLegacyProjectArtifacts(
  legacyDirectory: string,
  targetDirectory: string,
): Promise<number> {
  const artifacts = await listRetainedUnassignedArtifacts(legacyDirectory);
  let copied = 0;
  for (const name of artifacts) {
    const source = path.join(legacyDirectory, name);
    const target = path.join(targetDirectory, name);
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      let targetExisted = true;
      try {
        await stat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        targetExisted = false;
      }
      await cp(source, target, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      if (!targetExisted) copied += 1;
      continue;
    }
    if (await copyFileIfMissing(source, target)) {
      copied += 1;
    }
  }
  return copied;
}

async function listRetainedUnassignedArtifacts(
  legacyDirectory: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(legacyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return names
    .filter(name =>
      RETAINED_PROJECT_ARTIFACTS.has(name) ||
      /^issue-dispatch.*\.sqlite(?:-(?:shm|wal))?$/u.test(name)
    )
    .sort();
}

/**
 * Copy only records that can be attributed to one canonical project path.
 * The lossy legacy project directory is never used as a read fallback and is
 * left intact so ambiguous or unreadable records remain recoverable. Project
 * singleton artifacts are reported as retained-unassigned instead of guessed.
 */
export async function migrateLegacyHadamardProjectData(options: {
  homeDir: string;
  workDir: string;
  targetDirectory: string;
}): Promise<HadamardProjectDataMigrationSummary> {
  const targetDirectory = path.resolve(options.targetDirectory);
  const legacyDirectory = legacyProjectDirectory(options.workDir, options.homeDir);
  const sessionSources = [
    {
      source: path.join(legacyDirectory, 'sessions'),
      target: path.join(targetDirectory, 'sessions'),
      archived: false,
    },
    {
      source: path.join(legacyDirectory, 'archive'),
      target: path.join(targetDirectory, 'archive'),
      archived: true,
    },
  ];
  const sessionGroups = await Promise.all(
    sessionSources.map(async source => {
      const stored = await readStoredJsonFiles(source.source);
      return {
        ...source,
        entries: stored.entries.map(asSessionFile),
        hasUnassignedJson: stored.hasUnassignedJson,
      };
    }),
  );
  const allSessions = sessionGroups.flatMap(group => group.entries);
  const selectedSessions = new Set(selectProjectSessions(allSessions, options.workDir));
  const selectedSessionIds = uniquelySelectedIds(
    allSessions,
    selectedSessions,
    entry => [entry.sessionId],
  );
  const selectedSessionWorktrees = new Map<string, string[]>();
  for (const entry of selectedSessions) {
    if (
      !selectedSessionIds.has(entry.sessionId) ||
      !sessionUsesDeclaredWorktree(entry) ||
      !entry.worktreePath
    ) {
      continue;
    }
    const worktrees = selectedSessionWorktrees.get(entry.sessionId) ?? [];
    worktrees.push(entry.worktreePath);
    selectedSessionWorktrees.set(entry.sessionId, worktrees);
  }

  let sessions = 0;
  let archivedSessions = 0;
  if (!samePath(legacyDirectory, targetDirectory)) {
    for (const group of sessionGroups) {
      const copied = await copySessionFiles(
        group.entries.filter(entry => selectedSessions.has(entry)),
        group.source,
        group.target,
        options.workDir,
      );
      if (group.archived) {
        archivedSessions += copied;
      } else {
        sessions += copied;
      }
    }
  }

  const executionSource = path.join(legacyDirectory, 'agent-executions');
  const executionTarget = path.join(targetDirectory, 'agent-executions');
  const executionDirectory = await readStoredJsonFiles(executionSource);
  const executionEntries = executionDirectory.entries.map(asExecutionFile);
  const selectedExecutions = executionEntries.filter(entry => entry.workDir !== undefined
    ? pathBelongsToProject(entry.workDir, options.workDir) ||
      entry.sessionIds.some(sessionId =>
        selectedSessionWorktrees.get(sessionId)?.some(worktreePath =>
          samePath(worktreePath, entry.workDir!),
        ),
      )
    : entry.sessionIds.some(sessionId => selectedSessionIds.has(sessionId))
  );
  const selectedExecutionSet = new Set(selectedExecutions);
  const selectedExecutionIds = uniquelySelectedIds(
    executionEntries,
    selectedExecutionSet,
    entry => entry.executionIds,
  );
  const agentExecutions = samePath(legacyDirectory, targetDirectory)
    ? 0
    : await copyStoredJsonFiles(selectedExecutions, executionSource, executionTarget);

  const taskSource = path.join(legacyDirectory, 'tasks');
  const taskTarget = path.join(targetDirectory, 'tasks');
  const taskDirectory = await readStoredJsonFiles(taskSource);
  const taskEntries = taskDirectory.entries.map(asTaskFile);
  const taskReferencesSelectedProject = (entry: StoredTaskFile): boolean =>
    (entry.sessionId !== undefined && selectedSessionIds.has(entry.sessionId)) ||
      (entry.parentSessionId !== undefined && selectedSessionIds.has(entry.parentSessionId)) ||
      (entry.executionId !== undefined && selectedExecutionIds.has(entry.executionId));
  const selectedTasks = taskEntries.filter(entry => entry.workDir !== undefined
    ? pathBelongsToProject(entry.workDir, options.workDir) ||
      (
        entry.worktreePath !== undefined &&
        samePath(entry.worktreePath, entry.workDir) &&
        taskReferencesSelectedProject(entry)
      )
    : taskReferencesSelectedProject(entry)
  );
  const backgroundTasks = samePath(legacyDirectory, targetDirectory)
    ? 0
    : await copyStoredJsonFiles(selectedTasks, taskSource, taskTarget);

  const ownsLegacyArtifacts = await legacyArtifactsBelongToProject({
    homeDir: options.homeDir,
    workDir: options.workDir,
    legacyDirectory,
    sessionEntries: allSessions,
    selectedSessions,
    executionEntries,
    selectedExecutions,
    taskEntries,
    selectedTasks,
    hasUnassignedJson:
      sessionGroups.some(group => group.hasUnassignedJson) ||
      executionDirectory.hasUnassignedJson ||
      taskDirectory.hasUnassignedJson,
  });
  const projectArtifacts =
    !samePath(legacyDirectory, targetDirectory) && ownsLegacyArtifacts
      ? await copyLegacyProjectArtifacts(legacyDirectory, targetDirectory)
      : 0;

  const globalSessionsDirectory = path.join(
    resolveHadamardHome(options.homeDir),
    'actoviq-agent-sdk',
    'sessions',
  );
  const globalEntries = (await readStoredJsonFiles(globalSessionsDirectory)).entries
    .map(asSessionFile);
  const selectedGlobalSessions = selectProjectSessions(globalEntries, options.workDir);
  const globalSessions = await copySessionFiles(
    selectedGlobalSessions,
    globalSessionsDirectory,
    path.join(targetDirectory, 'sessions'),
    options.workDir,
  );
  const retainedUnassignedArtifacts = ownsLegacyArtifacts
    ? []
    : await listRetainedUnassignedArtifacts(legacyDirectory);

  return {
    sessions,
    archivedSessions,
    agentExecutions,
    backgroundTasks,
    globalSessions,
    projectArtifacts,
    retainedUnassignedArtifacts,
    total:
      sessions +
      archivedSessions +
      agentExecutions +
      backgroundTasks +
      globalSessions +
      projectArtifacts,
  };
}

export async function migrateLegacyHadamardProjectSessions(options: {
  homeDir: string;
  workDir: string;
  targetDirectory: string;
}): Promise<number> {
  const summary = await migrateLegacyHadamardProjectData(options);
  return summary.sessions + summary.archivedSessions + summary.globalSessions;
}

function samePath(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}
