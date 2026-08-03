import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';

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
  HadamardPreservedSegment,
  HadamardCompactState,
  HadamardCompactBoundaryMetadata,
  HadamardCompactStateOptions,
  HadamardMemoryFileHeader,
  HadamardMemoryOptions,
  HadamardMemoryPaths,
  HadamardMemoryPromptOptions,
  HadamardRelevantMemory,
  HadamardRelevantMemoryLookupOptions,
  HadamardSessionMemoryCompactConfig,
  HadamardSessionMemoryConfig,
  HadamardSessionMemoryProgress,
  HadamardMemorySettings,
  HadamardMemoryState,
  HadamardMemoryStateOptions,
  HadamardSessionMemoryState,
  HadamardSurfacedMemory,
  UpdateHadamardMemorySettingsInput,
} from '../types.js';


const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`.trim();

const MAX_SECTION_LENGTH = 2_000;
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 20_000;
const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

export interface HadamardMemoryBrowserEntry {
  id: string;
  kind: 'session' | 'durable' | 'raw';
  path: string;
  sessionId?: string;
  size: number;
  modifiedAt: string;
}

const DEFAULT_SESSION_MEMORY_CONFIG: HadamardSessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  maxOutputTokens: 10_000,
};

const DEFAULT_SESSION_MEMORY_COMPACT_CONFIG: HadamardSessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
};

function roughTokenCountEstimation(content: string): number {
  return Math.ceil(content.length / 4);
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
    sessionMemoryDir: safeSessionId
      ? joinUnderStorageRoot(projectStateDir, safeSessionId, 'session-memory')
      : undefined,
    sessionMemoryPath: safeSessionId
      ? joinUnderStorageRoot(projectStateDir, safeSessionId, 'session-memory', 'summary.md')
      : undefined,
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
    '- Session Memory and automatic Dream consolidation are written by dedicated runtime pipelines.',
    ...(skipIndex ? [] : [
      `- \`${ENTRYPOINT_NAME}\` is an index maintained by the restricted Dream pipeline.`,
    ]),
  ];

  return [
    '# Memory',
    '',
    `You have a persistent, file-based memory system with two directories: a private directory at \`${paths.autoMemoryDir}\` and a shared team directory at \`${paths.teamMemoryDir}\`.`,
    '',
    'Use memory for information that will be useful in future conversations, not for transient task state that only matters within the current turn.',
    '',
    '## Memory scope',
    '',
    `- private: memories that are private to the current user and stored under \`${paths.autoMemoryDir}\``,
    `- team: memories that are shared with collaborators in the current project and stored under \`${paths.teamMemoryDir}\``,
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

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match,
  );
}

function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {};
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = roughTokenCountEstimation(currentContent.join('\n').trim());
      }
      currentSection = line;
      currentContent = [];
      continue;
    }
    currentContent.push(line);
  }

  if (currentSection && currentContent.length > 0) {
    sections[currentSection] = roughTokenCountEstimation(currentContent.join('\n').trim());
  }

  return sections;
}

function generateSectionReminders(sectionSizes: Record<string, number>, totalTokens: number): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS;
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, left], [, right]) => right - left)
    .map(([section, tokens]) => `- "${section}" is ~${tokens} tokens (limit: ${MAX_SECTION_LENGTH})`);

  if (oversizedSections.length === 0 && !overBudget) {
    return '';
  }

  const parts: string[] = [];
  if (overBudget) {
    parts.push(
      `\n\nCRITICAL: The session memory file is currently ~${totalTokens} tokens, which exceeds the maximum of ${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens. Condense the file while keeping Current State and Errors & Corrections accurate.`,
    );
  }

  if (oversizedSections.length > 0) {
    parts.push(
      `\n\nOversized sections to condense:\n${oversizedSections.join('\n')}`,
    );
  }

  return parts.join('');
}

function buildCompactContinuationSummary(
  summary: string,
  transcriptPath?: string,
  recentMessagesPreserved = true,
): string {
  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary}`;

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction, read the full transcript at: ${transcriptPath}`;
  }

  if (recentMessagesPreserved) {
    baseSummary += '\n\nRecent messages are preserved verbatim.';
  }

  return `${baseSummary}

Continue the conversation from where it left off without asking the user to repeat prior context. Resume directly and keep moving on the most recent task.`;
}

function flushSessionSection(
  sectionHeader: string,
  sectionLines: string[],
  maxCharsPerSection: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!sectionHeader) {
    return { lines: sectionLines, wasTruncated: false };
  }

  const sectionContent = sectionLines.join('\n');
  if (sectionContent.length <= maxCharsPerSection) {
    return { lines: [sectionHeader, ...sectionLines], wasTruncated: false };
  }

  let charCount = 0;
  const keptLines: string[] = [sectionHeader];
  for (const line of sectionLines) {
    if (charCount + line.length + 1 > maxCharsPerSection) {
      break;
    }
    keptLines.push(line);
    charCount += line.length + 1;
  }
  keptLines.push('\n[... section truncated for length ...]');
  return { lines: keptLines, wasTruncated: true };
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
    const entrypoints = [
      {
        title: path.join(paths.autoMemoryDir, 'memory_summary.md'),
        content: (await readTextIfExists(path.join(paths.autoMemoryDir, 'memory_summary.md')))?.slice(0, 20_000),
      },
      {
        title: paths.autoMemoryEntrypoint,
        content: await readTextIfExists(paths.autoMemoryEntrypoint),
      },
      {
        title: paths.teamMemoryEntrypoint,
        content: await readTextIfExists(paths.teamMemoryEntrypoint),
      },
    ];

    for (const entrypoint of entrypoints) {
      lines.push('', `## ${entrypoint.title}`);
      if (entrypoint.content?.trim()) {
        lines.push('', truncateEntrypointContent(entrypoint.content).content);
      } else {
        lines.push('', `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`);
      }
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
    query: string,
    options: HadamardRelevantMemoryLookupOptions = {},
  ): Promise<HadamardSurfacedMemory[]> {
    const relevant = await this.findRelevantMemories(query, options);
    return readMemoriesForSurfacing(relevant);
  }

  async loadSessionTemplate(options: HadamardMemoryOptions = {}): Promise<string> {
    const homeDir = resolveHadamardHome(options.homeDir ?? this.defaults.homeDir);
    const templatePath = path.join(homeDir, 'session-memory', 'config', 'template.md');
    return (await readTextIfExists(templatePath)) ?? DEFAULT_SESSION_MEMORY_TEMPLATE;
  }

  async loadSessionPrompt(options: HadamardMemoryOptions = {}): Promise<string> {
    const homeDir = resolveHadamardHome(options.homeDir ?? this.defaults.homeDir);
    const promptPath = path.join(homeDir, 'session-memory', 'config', 'prompt.md');
    return (
      (await readTextIfExists(promptPath)) ??
      `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, HADAMARD.md entries, or any past session summaries), update the session notes file.

The file {{notesPath}} has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the notes file, then stop. You can make multiple edits - make all Edit tool calls in parallel in a single message. Do not call any other tools.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
-- NEVER modify, delete, or add section headers (the lines starting with # like # Task specification)
-- NEVER modify or delete the italic _section description_ lines
-- ONLY update the actual content that appears BELOW the italic _section descriptions_ within each existing section
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to skip updating a section if there are no substantial new insights to add
- Write detailed, information-dense content for each section
- Keep each section under ~${MAX_SECTION_LENGTH} tokens/words
- IMPORTANT: Always update "Current State" to reflect the most recent work

Use the Edit tool with file_path: {{notesPath}}.

REMEMBER: Use the Edit tool in parallel and stop. Do not continue after the edits.`
    );
  }

  async buildSessionUpdatePrompt(
    currentNotes: string,
    notesPath: string,
    options: HadamardMemoryOptions = {},
  ): Promise<string> {
    const promptTemplate = await this.loadSessionPrompt(options);
    const sectionSizes = analyzeSectionSizes(currentNotes);
    const totalTokens = roughTokenCountEstimation(currentNotes);
    const reminders = generateSectionReminders(sectionSizes, totalTokens);
    return (
      substituteVariables(promptTemplate, {
        currentNotes,
        notesPath,
      }) + reminders
    );
  }

  async buildSessionRewritePrompt(
    currentNotes: string,
    notesPath: string,
    _options: HadamardMemoryOptions = {},
  ): Promise<string> {
    const sectionSizes = analyzeSectionSizes(currentNotes);
    const totalTokens = roughTokenCountEstimation(currentNotes);
    const reminders = generateSectionReminders(sectionSizes, totalTokens);
    return `IMPORTANT: This is a runtime-managed note extraction task, not part of the user conversation.

Update the existing Session Memory notes shown below using the completed conversation turn. Do not call tools and do not describe the note-taking process.

Notes path (informational only; the runtime performs the write): ${notesPath}
<current_notes_content>
${currentNotes}
</current_notes_content>

Return only JSON: {"noOutput":false,"content":"<full updated markdown>"}.
- Return {"noOutput":true,"content":""} when there is no meaningful new knowledge
- Do not explain what you changed
- Preserve every existing section header and italic guide line exactly
- Only update the section bodies beneath those guides
- If a section has no meaningful updates, keep its existing content unchanged
- Keep each section under approximately ${MAX_SECTION_LENGTH} tokens/words
- Always keep Current State aligned with the latest completed turn${reminders}`;
  }

  async ensureSessionMemory(
    options: HadamardMemoryOptions = {},
  ): Promise<{ path: string; content: string; created: boolean }> {
    const paths = await this.paths(options);
    if (!paths.sessionMemoryPath || !paths.sessionMemoryDir) {
      throw new Error('A sessionId is required to create or update session memory.');
    }

    await mkdir(paths.sessionMemoryDir, { recursive: true });
    const existing = await readTextIfExists(paths.sessionMemoryPath);
    if (existing != null) {
      return {
        path: paths.sessionMemoryPath,
        content: existing,
        created: false,
      };
    }

    const template = await this.loadSessionTemplate(options);
    await writeFile(paths.sessionMemoryPath, `${template.trim()}\n`, 'utf8');
    return {
      path: paths.sessionMemoryPath,
      content: template,
      created: true,
    };
  }

  async writeSessionMemory(
    content: string,
    options: HadamardMemoryOptions = {},
  ): Promise<{ path: string; content: string }> {
    const ensured = await this.ensureSessionMemory(options);
    const tempPath = `${ensured.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${content.trim()}\n`, 'utf8');
    try {
      await rename(tempPath, ensured.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    return {
      path: ensured.path,
      content: content.trim(),
    };
  }

  async isSessionMemoryEmpty(
    content: string,
    options: HadamardMemoryOptions = {},
  ): Promise<boolean> {
    const template = await this.loadSessionTemplate(options);
    return content.trim() === template.trim();
  }

  truncateSessionMemoryForCompact(content: string): {
    truncatedContent: string;
    wasTruncated: boolean;
  } {
    const lines = content.split('\n');
    const maxCharsPerSection = MAX_SECTION_LENGTH * 4;
    const outputLines: string[] = [];
    let currentSectionHeader = '';
    let currentSectionLines: string[] = [];
    let wasTruncated = false;

    for (const line of lines) {
      if (line.startsWith('# ')) {
        const result = flushSessionSection(
          currentSectionHeader,
          currentSectionLines,
          maxCharsPerSection,
        );
        outputLines.push(...result.lines);
        wasTruncated = wasTruncated || result.wasTruncated;
        currentSectionHeader = line;
        currentSectionLines = [];
        continue;
      }
      currentSectionLines.push(line);
    }

    const result = flushSessionSection(
      currentSectionHeader,
      currentSectionLines,
      maxCharsPerSection,
    );
    outputLines.push(...result.lines);
    wasTruncated = wasTruncated || result.wasTruncated;

    return {
      truncatedContent: outputLines.join('\n'),
      wasTruncated,
    };
  }

  async readSessionMemory(options: HadamardMemoryOptions = {}): Promise<HadamardSessionMemoryState> {
    const paths = await this.paths(options);
    const summaryPath = paths.sessionMemoryPath;
    if (!summaryPath) {
      return { exists: false };
    }

    const content = await readTextIfExists(summaryPath);
    if (content == null) {
      return {
        exists: false,
        path: summaryPath,
      };
    }

    const truncated = this.truncateSessionMemoryForCompact(content);
    return {
      exists: true,
      path: summaryPath,
      content,
      isEmpty: await this.isSessionMemoryEmpty(content, options),
      tokenEstimate: roughTokenCountEstimation(content),
      truncatedContent: truncated.truncatedContent,
      wasTruncated: truncated.wasTruncated,
    };
  }

  getSessionMemoryConfig(): HadamardSessionMemoryConfig {
    return {
      ...DEFAULT_SESSION_MEMORY_CONFIG,
      ...(this.defaults.sessionMemoryConfig ?? {}),
    };
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
    let projectChildren: string[] = [];
    try {
      projectChildren = await readdir(paths.projectStateDir);
    } catch {
      projectChildren = [];
    }
    for (const sessionId of projectChildren) {
      const summaryPath = path.join(paths.projectStateDir, sessionId, 'session-memory', 'summary.md');
      try {
        const stats = await stat(summaryPath);
        if (!stats.isFile()) continue;
        entries.push({
          id: `session:${sessionId}`,
          kind: 'session',
          path: summaryPath,
          sessionId,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      } catch {
        // Not a Session Memory directory.
      }
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

  getSessionMemoryCompactConfig(): HadamardSessionMemoryCompactConfig {
    return {
      ...DEFAULT_SESSION_MEMORY_COMPACT_CONFIG,
    };
  }

  evaluateSessionMemoryProgress(options: {
    currentTokenCount?: number;
    tokensAtLastExtraction?: number;
    messageCountSinceLastExtraction?: number;
    initialized?: boolean;
    hasToolCallsInLastTurn?: boolean;
    toolCallsSinceLastUpdate?: number;
  }): HadamardSessionMemoryProgress {
    const config = this.getSessionMemoryConfig();
    const currentTokenCount = options.currentTokenCount;
    const tokensAtLastExtraction = options.tokensAtLastExtraction ?? 0;
    const tokensSinceLastExtraction =
      typeof currentTokenCount === 'number'
        ? Math.max(currentTokenCount - tokensAtLastExtraction, 0)
        : undefined;
    const meetsInitializationThreshold =
      typeof currentTokenCount === 'number'
        ? currentTokenCount >= config.minimumMessageTokensToInit
        : undefined;
    const meetsUpdateThreshold =
      typeof tokensSinceLastExtraction === 'number'
        ? tokensSinceLastExtraction >= config.minimumTokensBetweenUpdate
        : undefined;
    const meetsToolCallThreshold =
      typeof options.toolCallsSinceLastUpdate === 'number'
        ? options.toolCallsSinceLastUpdate >= config.toolCallsBetweenUpdates
        : undefined;
    const hasToolCallsInLastTurn = options.hasToolCallsInLastTurn;
    const initialized =
      options.initialized === true || meetsInitializationThreshold === true;
    const shouldExtract = initialized && meetsUpdateThreshold === true && hasToolCallsInLastTurn !== true;

    return {
      currentTokenCount,
      tokensAtLastExtraction,
      tokensSinceLastExtraction,
      messageCountSinceLastExtraction: options.messageCountSinceLastExtraction,
      toolCallsSinceLastUpdate: options.toolCallsSinceLastUpdate,
      initialized,
      meetsInitializationThreshold,
      meetsUpdateThreshold,
      meetsToolCallThreshold,
      hasToolCallsInLastTurn,
      shouldExtract,
    };
  }

  async buildSessionMemoryCompactSummary(options: {
    sessionId?: string;
    projectPath?: string;
    transcriptPath?: string;
    includeFullMemoryPathHint?: boolean;
    recentMessagesPreserved?: boolean;
  } = {}): Promise<string | undefined> {
    const state = await this.readSessionMemory({
      sessionId: options.sessionId ?? this.defaults.sessionId,
      projectPath: options.projectPath ?? this.defaults.projectPath,
    });
    if (!state.exists || !state.content || state.isEmpty) {
      return undefined;
    }

    const paths = await this.paths({
      sessionId: options.sessionId ?? this.defaults.sessionId,
      projectPath: options.projectPath ?? this.defaults.projectPath,
    });

    let summaryContent = state.truncatedContent ?? state.content;
    if (roughTokenCountEstimation(summaryContent) > 5_000) {
      summaryContent = `${summaryContent.slice(0, 20_000).trimEnd()}\n\n[Session Memory truncated to the 5,000-token injection budget.]`;
    }
    if (state.wasTruncated && options.includeFullMemoryPathHint !== false && paths.sessionMemoryPath) {
      summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${paths.sessionMemoryPath}`;
    }

    return buildCompactContinuationSummary(
      summaryContent,
      options.transcriptPath,
      options.recentMessagesPreserved ?? true,
    );
  }

  async compactState(options: HadamardCompactStateOptions = {}): Promise<HadamardCompactState> {
    const baseState = await this.state({
      ...options,
      includeSessionMemory: options.includeSessionMemory ?? true,
    });
    const sessionMemoryConfig = this.getSessionMemoryConfig();
    const sessionMemoryCompactConfig = this.getSessionMemoryCompactConfig();
    const sessionId = options.sessionId ?? this.defaults.sessionId;
    const transcriptPath =
      sessionId != null
        ? joinUnderStorageRoot(
            baseState.paths.projectStateDir,
            safeStorageFileName('sessionId', sessionId, 'jsonl'),
          )
        : undefined;
    const progress =
      options.currentTokenCount != null ||
      options.tokensAtLastExtraction != null ||
      options.initialized != null ||
      options.toolCallsSinceLastUpdate != null
        ? this.evaluateSessionMemoryProgress({
            currentTokenCount: options.currentTokenCount,
            tokensAtLastExtraction: options.tokensAtLastExtraction,
            initialized: options.initialized,
            toolCallsSinceLastUpdate: options.toolCallsSinceLastUpdate,
          })
        : undefined;

    const boundaries = undefined;
    const latestBoundary = undefined;
    const compactCount = 0;
    const microcompactCount = 0;
    const lastSummarizedMessageUuid: string | undefined = undefined;
    const latestPreservedSegment: HadamardPreservedSegment | undefined = undefined;
    const latestBoundarySummary: string | undefined = undefined;

    return {
      ...baseState,
      sessionMemoryConfig,
      sessionMemoryCompactConfig,
      progress,
      runtimeState: options.runtimeState,
      transcriptPath,
      boundaries,
      latestBoundary,
      compactCount,
      microcompactCount,
      hasCompacted: compactCount + microcompactCount > 0,
      pendingPostCompaction: options.runtimeState?.pendingPostCompaction,
      lastSummarizedMessageUuid,
      latestPreservedSegment,
      latestBoundarySummary,
      canUseSessionMemoryCompaction:
        baseState.enabled.autoCompact &&
        baseState.sessionMemory?.exists === true &&
        baseState.sessionMemory?.isEmpty === false,
      summaryMessage: options.includeSummaryMessage
        ? await this.buildSessionMemoryCompactSummary({
            sessionId,
            projectPath: baseState.paths.projectPath,
            transcriptPath,
          })
        : undefined,
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
      sessionMemory: options.includeSessionMemory
        ? await this.readSessionMemory(options)
        : undefined,
      sessionTemplate: options.includeSessionTemplate
        ? await this.loadSessionTemplate(options)
        : undefined,
      sessionPrompt: options.includeSessionPrompt
        ? await this.loadSessionPrompt(options)
        : undefined,
    };
  }
}

export function createHadamardMemoryApi(options: HadamardMemoryOptions = {}): HadamardMemoryApi {
  return new HadamardMemoryApi(options);
}

export function getHadamardDefaultSessionMemoryTemplate(): string {
  return DEFAULT_SESSION_MEMORY_TEMPLATE;
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

export function getHadamardDefaultSessionMemoryConfig(): HadamardSessionMemoryConfig {
  return {
    ...DEFAULT_SESSION_MEMORY_CONFIG,
  };
}

export function getHadamardDefaultSessionMemoryCompactConfig(): HadamardSessionMemoryCompactConfig {
  return {
    ...DEFAULT_SESSION_MEMORY_COMPACT_CONFIG,
  };
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
