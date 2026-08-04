import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import {
  getDefaultHadamardSettingsPath,
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from '../config/hadamardSettingsStore.js';
import { resolveHadamardHome } from '../config/hadamardHome.js';
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from '../storage/pathSafety.js';
import {
  formatMemoryManifest,
  memoryAge,
  memoryAgeDays,
  memoryFreshnessNote,
  memoryFreshnessText,
  memoryHeader,
  readMemoriesForSurfacing,
  scanMemoryFiles,
  selectRelevantMemories,
} from './hadamardRelevantMemories.js';
import type {
  HadamardCompactState,
  HadamardCompactBoundaryMetadata,
  HadamardCompactStateOptions,
  HadamardMemoryFileHeader,
  HadamardMemoryOptions,
  HadamardMemoryPaths,
  HadamardMemoryPromptOptions,
  HadamardRelevantMemory,
  HadamardRelevantMemoryLookupOptions,
  HadamardMemorySettings,
  HadamardMemoryState,
  HadamardMemoryStateOptions,
  HadamardSurfacedMemory,
  UpdateHadamardMemorySettingsInput,
} from '../types.js';

const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

export interface HadamardMemoryBrowserEntry {
  id: string;
  kind: 'durable' | 'raw';
  path: string;
  size: number;
  modifiedAt: string;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function resolveProjectPath(projectPath?: string): string {
  return path.resolve(projectPath ?? process.cwd());
}

function getProjectStateDir(memoryBaseDir: string, projectPath: string): string {
  const resolvedProjectPath = resolveProjectPath(projectPath);
  const digest = createHash('sha1')
    .update(process.platform === 'win32' ? resolvedProjectPath.toLowerCase() : resolvedProjectPath)
    .digest('hex')
    .slice(0, 16);
  const label = sanitizeSegment(path.basename(resolvedProjectPath));
  return path.join(memoryBaseDir, 'projects', `${label}-${digest}`);
}

function normalizeDirectory(value: string): string {
  return path.resolve(value);
}

function expandTilde(value: string, homeDir: string): string {
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function getMemoryBaseDir(raw: Record<string, unknown>, homeDir: string): string {
  const env = raw.env;
  if (typeof process.env.HADAMARD_REMOTE_MEMORY_DIR === 'string' && process.env.HADAMARD_REMOTE_MEMORY_DIR) {
    return normalizeDirectory(process.env.HADAMARD_REMOTE_MEMORY_DIR);
  }
  if (typeof process.env.HADAMARD_CONFIG_DIR === 'string' && process.env.HADAMARD_CONFIG_DIR) {
    return normalizeDirectory(process.env.HADAMARD_CONFIG_DIR);
  }
  if (typeof env === 'object' && env !== null) {
    const remoteMemoryDir = (env as Record<string, unknown>).HADAMARD_REMOTE_MEMORY_DIR;
    if (typeof remoteMemoryDir === 'string' && remoteMemoryDir) {
      return normalizeDirectory(remoteMemoryDir);
    }
    const configDir = (env as Record<string, unknown>).HADAMARD_CONFIG_DIR;
    if (typeof configDir === 'string' && configDir) {
      return normalizeDirectory(configDir);
    }
  }
  return resolveHadamardHome(homeDir);
}

function getAutoMemoryDirectory(
  raw: Record<string, unknown>,
  homeDir: string,
  memoryBaseDir: string,
  projectPath: string,
): string {
  if (
    typeof process.env.HADAMARD_COWORK_MEMORY_PATH_OVERRIDE === 'string' &&
    process.env.HADAMARD_COWORK_MEMORY_PATH_OVERRIDE
  ) {
    return normalizeDirectory(process.env.HADAMARD_COWORK_MEMORY_PATH_OVERRIDE);
  }

  if (typeof raw.autoMemoryDirectory === 'string' && raw.autoMemoryDirectory.trim()) {
    return normalizeDirectory(expandTilde(raw.autoMemoryDirectory, homeDir));
  }

  return path.join(getProjectStateDir(memoryBaseDir, projectPath), 'memory');
}

function parseSettings(raw: Record<string, unknown>): HadamardMemorySettings {
  return {
    autoCompactEnabled:
      typeof raw.autoCompactEnabled === 'boolean' ? raw.autoCompactEnabled : undefined,
    autoMemoryEnabled:
      typeof raw.autoMemoryEnabled === 'boolean' ? raw.autoMemoryEnabled : undefined,
    autoDreamEnabled:
      typeof raw.autoDreamEnabled === 'boolean' ? raw.autoDreamEnabled : undefined,
    autoMemoryDirectory:
      typeof raw.autoMemoryDirectory === 'string' && raw.autoMemoryDirectory.trim()
        ? raw.autoMemoryDirectory
        : undefined,
  };
}

function buildPaths(
  raw: Record<string, unknown>,
  configPath: string,
  homeDir: string,
  projectPath: string,
  sessionId?: string,
): HadamardMemoryPaths {
  const memoryBaseDir = getMemoryBaseDir(raw, homeDir);
  const projectStateDir = getProjectStateDir(memoryBaseDir, projectPath);
  const autoMemoryDir = getAutoMemoryDirectory(raw, homeDir, memoryBaseDir, projectPath);
  const safeSessionId = sessionId
    ? assertSafeStorageSegment('sessionId', sessionId)
    : undefined;

  return {
    configPath,
    homeDir,
    projectPath: resolveProjectPath(projectPath),
    memoryBaseDir,
    projectStateDir,
    autoMemoryDir,
    autoMemoryEntrypoint: path.join(autoMemoryDir, ENTRYPOINT_NAME),
    teamMemoryDir: path.join(autoMemoryDir, 'team'),
    teamMemoryEntrypoint: path.join(autoMemoryDir, 'team', ENTRYPOINT_NAME),
    sessionId: safeSessionId,
  };
}

function buildCombinedMemoryPrompt(
  paths: HadamardMemoryPaths,
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const howToSave = [
    '## How memory is updated',
    '',
    '- Treat durable memory as read-only during the main chat.',
    '- Never use ordinary Write or Edit calls to silently modify durable memory.',
    '- To suggest a durable fact, use ProposeMemory. The runtime writes it only after the user applies the proposal.',
    '- Automatic Dream consolidation rewrites MEMORY.md and memory_summary.md.',
    ...(skipIndex ? [] : [
      `- Detailed durable memory lives in \`${paths.autoMemoryEntrypoint}\`.`,
      `- Only \`memory_summary.md\` is auto-injected into this prompt; Read MEMORY.md when you need detail.`,
    ]),
  ];

  return [
    '# Memory',
    '',
    `You have a persistent file-based durable memory under \`${paths.autoMemoryDir}\`.`,
    '',
    'Use memory for information that will be useful in future conversations, not for transient task state that only matters within the current turn.',
    '',
    '## What to save',
    '',
    '- collaboration preferences that remain useful over time',
    '- long-lived project context and conventions',
    '- reference knowledge worth reusing in future sessions',
    '- important feedback that should change future behavior',
    '',
    '## What not to save',
    '',
    '- secrets, credentials, or API keys',
    '- short-lived task progress that belongs in a plan or task list',
    '- redundant or outdated copies of existing memories',
    '',
    ...howToSave,
    '',
    '## When to access memories',
    '',
    '- when the user explicitly asks you to remember, recall, or check memory',
    '- when prior collaboration context seems directly relevant',
    `- Read \`${paths.autoMemoryEntrypoint}\` for full detail; the summary below is only a map`,
    '- if the user asks you to ignore memory, behave as if MEMORY.md were empty',
    '',
    '## Memory and other forms of persistence',
    '',
    '- use plans for implementation strategy within the current conversation',
    '- use tasks for step-by-step progress tracking in the current conversation',
    '- use memory for reusable, future-facing context',
    ...(extraGuidelines ?? []),
  ].join('\n');
}

function truncateEntrypointContent(raw: string): {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
} {
  const trimmed = raw.trim();
  const contentLines = trimmed.split('\n');
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed;
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES})`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries concise and move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const normalized = error as NodeJS.ErrnoException;
    if (normalized?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'team') continue;
        await visit(target);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(target);
      }
    }
  };
  await visit(root);
  return files;
}

export class HadamardMemoryApi {
  constructor(private readonly defaults: HadamardMemoryOptions = {}) {}

  async paths(options: HadamardMemoryOptions = {}): Promise<HadamardMemoryPaths> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath ?? this.defaults.configPath,
      homeDir: options.homeDir ?? this.defaults.homeDir,
    });
    return buildPaths(
      store.raw,
      store.configPath,
      store.homeDir,
      options.projectPath ?? this.defaults.projectPath ?? process.cwd(),
      options.sessionId ?? this.defaults.sessionId,
    );
  }

  async getSettings(options: HadamardMemoryOptions = {}): Promise<HadamardMemorySettings> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath ?? this.defaults.configPath,
      homeDir: options.homeDir ?? this.defaults.homeDir,
    });
    return parseSettings(store.raw);
  }

  async updateSettings(
    patch: UpdateHadamardMemorySettingsInput,
    options: HadamardMemoryOptions = {},
  ): Promise<HadamardMemorySettings> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath ?? this.defaults.configPath,
      homeDir: options.homeDir ?? this.defaults.homeDir,
    });

    const nextRaw: Record<string, unknown> = {
      ...store.raw,
    };

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      if (key === 'autoMemoryDirectory' && value === null) {
        delete nextRaw.autoMemoryDirectory;
        continue;
      }
      nextRaw[key] = value;
    }

    await persistHadamardSettingsStore(store.configPath, nextRaw);
    return parseSettings(nextRaw);
  }

  async buildCombinedPrompt(options: HadamardMemoryPromptOptions = {}): Promise<string> {
    const paths = await this.paths(options);
    return buildCombinedMemoryPrompt(paths, options.extraGuidelines, options.skipIndex);
  }

  async buildPromptWithEntrypoints(options: HadamardMemoryPromptOptions = {}): Promise<string> {
    const paths = await this.paths(options);
    const lines = [
      buildCombinedMemoryPrompt(paths, options.extraGuidelines, options.skipIndex),
    ];
    const summaryPath = path.join(paths.autoMemoryDir, 'memory_summary.md');
    const summaryContent = (await readTextIfExists(summaryPath))?.slice(0, 20_000);
    lines.push('', `## ${summaryPath}`);
    if (summaryContent?.trim()) {
      lines.push('', truncateEntrypointContent(summaryContent).content);
    } else {
      lines.push(
        '',
        `memory_summary.md is currently empty. After Dream runs, it will map sections of \`${paths.autoMemoryEntrypoint}\`.`,
      );
    }

    return lines.join('\n');
  }

  async scanMemoryFiles(options: HadamardMemoryOptions = {}): Promise<HadamardMemoryFileHeader[]> {
    const paths = await this.paths(options);
    const [privateMemories, teamMemories] = await Promise.all([
      scanMemoryFiles(paths.autoMemoryDir, 'private'),
      scanMemoryFiles(paths.teamMemoryDir, 'team'),
    ]);
    const teamPrefix = `${paths.teamMemoryDir}${path.sep}`;
    const filteredPrivate = privateMemories.filter(
      memory => memory.filePath !== paths.teamMemoryEntrypoint && !memory.filePath.startsWith(teamPrefix),
    );
    return [...filteredPrivate, ...teamMemories].sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  async formatMemoryManifest(options: HadamardMemoryOptions = {}): Promise<string> {
    return formatMemoryManifest(await this.scanMemoryFiles(options));
  }

  async findRelevantMemories(
    query: string,
    options: HadamardRelevantMemoryLookupOptions = {},
  ): Promise<HadamardRelevantMemory[]> {
    const memories = await this.scanMemoryFiles(options);
    return selectRelevantMemories(query, memories, {
      recentTools: options.recentTools,
      alreadySurfacedPaths: options.alreadySurfacedPaths
        ? new Set(options.alreadySurfacedPaths)
        : undefined,
      limit: options.limit,
    });
  }

  async surfaceRelevantMemories(
    _query: string,
    _options: HadamardRelevantMemoryLookupOptions = {},
  ): Promise<HadamardSurfacedMemory[]> {
    // Topic/file auto-surfacing removed: only memory_summary.md is injected via
    // the system prompt; agents Read MEMORY.md on demand.
    return [];
  }

  async listMemoryContent(
    options: HadamardMemoryOptions & { kind?: HadamardMemoryBrowserEntry['kind'] } = {},
  ): Promise<HadamardMemoryBrowserEntry[]> {
    const paths = await this.paths(options);
    const entries: HadamardMemoryBrowserEntry[] = [];
    const durableFiles = await listMarkdownFiles(paths.autoMemoryDir);
    for (const filePath of durableFiles) {
      const relative = path.relative(paths.autoMemoryDir, filePath).replaceAll(path.sep, '/');
      if (relative === 'team' || relative.startsWith('team/')) continue;
      const raw = relative === 'raw_memories.md' || relative.startsWith('rollout_summaries/');
      const stats = await stat(filePath);
      entries.push({
        id: `${raw ? 'raw' : 'durable'}:${relative}`,
        kind: raw ? 'raw' : 'durable',
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
    return entries
      .filter(entry => options.kind == null || entry.kind === options.kind)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async readMemoryContent(
    idOrPath: string,
    options: HadamardMemoryOptions = {},
  ): Promise<{ entry: HadamardMemoryBrowserEntry; content: string }> {
    const entries = await this.listMemoryContent(options);
    const resolved = path.resolve(idOrPath);
    const entry = entries.find(candidate =>
      candidate.id === idOrPath || path.resolve(candidate.path) === resolved
    );
    if (!entry) throw new Error(`Memory content not found in the current project: ${idOrPath}`);
    return { entry, content: await readFile(entry.path, 'utf8') };
  }

  async searchMemoryContent(
    query: string,
    options: HadamardMemoryOptions & { kind?: HadamardMemoryBrowserEntry['kind'] } = {},
  ): Promise<Array<{ entry: HadamardMemoryBrowserEntry; matches: string[] }>> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const results: Array<{ entry: HadamardMemoryBrowserEntry; matches: string[] }> = [];
    for (const entry of await this.listMemoryContent(options)) {
      const lines = (await readFile(entry.path, 'utf8')).split(/\r?\n/u);
      const matches = lines.filter(line => line.toLowerCase().includes(normalized)).slice(0, 20);
      if (matches.length > 0) results.push({ entry, matches });
    }
    return results;
  }

  async compactState(options: HadamardCompactStateOptions = {}): Promise<HadamardCompactState> {
    const baseState = await this.state(options);
    const sessionId = options.sessionId ?? this.defaults.sessionId;
    const transcriptPath =
      sessionId != null
        ? joinUnderStorageRoot(
            baseState.paths.projectStateDir,
            safeStorageFileName('sessionId', sessionId, 'jsonl'),
          )
        : undefined;

    return {
      ...baseState,
      runtimeState: options.runtimeState,
      transcriptPath,
      boundaries: undefined,
      latestBoundary: undefined,
      compactCount: 0,
      microcompactCount: 0,
      hasCompacted: false,
      pendingPostCompaction: options.runtimeState?.pendingPostCompaction,
      lastSummarizedMessageUuid: undefined,
      latestPreservedSegment: undefined,
      latestBoundarySummary: undefined,
    };
  }

  async state(options: HadamardMemoryStateOptions = {}): Promise<HadamardMemoryState> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath ?? this.defaults.configPath,
      homeDir: options.homeDir ?? this.defaults.homeDir,
    });
    const settings = parseSettings(store.raw);
    const paths = buildPaths(
      store.raw,
      store.configPath,
      store.homeDir,
      options.projectPath ?? this.defaults.projectPath ?? process.cwd(),
      options.sessionId ?? this.defaults.sessionId,
    );

    const enabled = {
      autoCompact: options.enabledOverrides?.autoCompact
        ?? this.defaults.enabledOverrides?.autoCompact
        ?? settings.autoCompactEnabled !== false,
      autoMemory: options.enabledOverrides?.autoMemory
        ?? this.defaults.enabledOverrides?.autoMemory
        ?? settings.autoMemoryEnabled !== false,
      autoDream: options.enabledOverrides?.autoDream
        ?? this.defaults.enabledOverrides?.autoDream
        ?? settings.autoDreamEnabled === true,
    };

    return {
      settings,
      enabled,
      paths,
      combinedPrompt: options.includeCombinedPrompt
        ? buildCombinedMemoryPrompt(paths, options.extraGuidelines, options.skipIndex)
        : undefined,
    };
  }
}

export function createHadamardMemoryApi(options: HadamardMemoryOptions = {}): HadamardMemoryApi {
  return new HadamardMemoryApi(options);
}

export function getHadamardCompactBoundarySummary(
  metadata: HadamardCompactBoundaryMetadata | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const parts = [
    metadata.trigger ? `trigger=${metadata.trigger}` : undefined,
    typeof metadata.preTokens === 'number' ? `preTokens=${metadata.preTokens}` : undefined,
    typeof metadata.messagesSummarized === 'number'
      ? `messagesSummarized=${metadata.messagesSummarized}`
      : undefined,
    typeof metadata.preservedMessages === 'number'
      ? `preservedMessages=${metadata.preservedMessages}`
      : undefined,
    typeof metadata.droppedMessages === 'number'
      ? `droppedMessages=${metadata.droppedMessages}`
      : undefined,
    typeof metadata.retryCount === 'number'
      ? `retryCount=${metadata.retryCount}`
      : undefined,
    typeof metadata.continuationDepth === 'number'
      ? `continuationDepth=${metadata.continuationDepth}`
      : undefined,
    metadata.preservedSegment
      ? `preservedSegment=${metadata.preservedSegment.headUuid}->${metadata.preservedSegment.anchorUuid}->${metadata.preservedSegment.tailUuid}`
      : undefined,
    metadata.userContext ? `userContext=${metadata.userContext}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

export {
  formatMemoryManifest as formatHadamardMemoryManifest,
  memoryAge as getHadamardMemoryAge,
  memoryAgeDays as getHadamardMemoryAgeDays,
  memoryFreshnessNote as getHadamardMemoryFreshnessNote,
  memoryFreshnessText as getHadamardMemoryFreshnessText,
  memoryHeader as getHadamardMemoryHeader,
  readMemoriesForSurfacing as readHadamardMemoriesForSurfacing,
  scanMemoryFiles as scanHadamardMemoryFiles,
  selectRelevantMemories as selectHadamardRelevantMemories,
};

export function getHadamardDefaultSettingsPath(options: { homeDir?: string } = {}): string {
  return getDefaultHadamardSettingsPath(options.homeDir);
}
