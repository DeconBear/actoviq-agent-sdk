import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  getDefaultActoviqSettingsPath,
  persistActoviqSettingsStore,
  resolveActoviqSettingsStore,
} from '../config/actoviqSettingsStore.js';
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
} from './actoviqRelevantMemories.js';
import type {
  ActoviqPreservedSegment,
  ActoviqCompactState,
  ActoviqCompactBoundaryMetadata,
  ActoviqCompactStateOptions,
  ActoviqMemoryFileHeader,
  ActoviqMemoryOptions,
  ActoviqMemoryPaths,
  ActoviqMemoryPromptOptions,
  ActoviqRelevantMemory,
  ActoviqRelevantMemoryLookupOptions,
  ActoviqSessionMemoryCompactConfig,
  ActoviqSessionMemoryConfig,
  ActoviqSessionMemoryProgress,
  ActoviqMemorySettings,
  ActoviqMemoryState,
  ActoviqMemoryStateOptions,
  ActoviqSessionMemoryState,
  ActoviqSurfacedMemory,
  ActoviqTranscriptBoundary,
  UpdateActoviqMemorySettingsInput,
} from '../types.js';
import { getActoviqBridgeCompactBoundaries } from '../parity/actoviqTranscripts.js';

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
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000;
const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

const DEFAULT_SESSION_MEMORY_CONFIG: ActoviqSessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
};

const DEFAULT_SESSION_MEMORY_COMPACT_CONFIG: ActoviqSessionMemoryCompactConfig = {
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
  if (typeof process.env.ACTOVIQ_REMOTE_MEMORY_DIR === 'string' && process.env.ACTOVIQ_REMOTE_MEMORY_DIR) {
    return normalizeDirectory(process.env.ACTOVIQ_REMOTE_MEMORY_DIR);
  }
  if (typeof process.env.ACTOVIQ_CONFIG_DIR === 'string' && process.env.ACTOVIQ_CONFIG_DIR) {
    return normalizeDirectory(process.env.ACTOVIQ_CONFIG_DIR);
  }
  if (typeof env === 'object' && env !== null) {
    const remoteMemoryDir = (env as Record<string, unknown>).ACTOVIQ_REMOTE_MEMORY_DIR;
    if (typeof remoteMemoryDir === 'string' && remoteMemoryDir) {
      return normalizeDirectory(remoteMemoryDir);
    }
    const configDir = (env as Record<string, unknown>).ACTOVIQ_CONFIG_DIR;
    if (typeof configDir === 'string' && configDir) {
      return normalizeDirectory(configDir);
    }
  }
  return path.join(homeDir, '.actoviq');
}

function getAutoMemoryDirectory(
  raw: Record<string, unknown>,
  homeDir: string,
  memoryBaseDir: string,
  projectPath: string,
): string {
  if (
    typeof process.env.ACTOVIQ_COWORK_MEMORY_PATH_OVERRIDE === 'string' &&
    process.env.ACTOVIQ_COWORK_MEMORY_PATH_OVERRIDE
  ) {
    return normalizeDirectory(process.env.ACTOVIQ_COWORK_MEMORY_PATH_OVERRIDE);
  }

  if (typeof raw.autoMemoryDirectory === 'string' && raw.autoMemoryDirectory.trim()) {
    return normalizeDirectory(expandTilde(raw.autoMemoryDirectory, homeDir));
  }

  return path.join(getProjectStateDir(memoryBaseDir, projectPath), 'memory');
}

function parseSettings(raw: Record<string, unknown>): ActoviqMemorySettings {
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
): ActoviqMemoryPaths {
  const memoryBaseDir = getMemoryBaseDir(raw, homeDir);
  const projectStateDir = getProjectStateDir(memoryBaseDir, projectPath);
  const autoMemoryDir = getAutoMemoryDirectory(raw, homeDir, memoryBaseDir, projectPath);

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
    sessionId,
    sessionMemoryDir: sessionId
      ? path.join(projectStateDir, sessionId, 'session-memory')
      : undefined,
    sessionMemoryPath: sessionId
      ? path.join(projectStateDir, sessionId, 'session-memory', 'summary.md')
      : undefined,
  };
}

function buildCombinedMemoryPrompt(
  paths: ActoviqMemoryPaths,
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file in the chosen directory using the frontmatter format described below.',
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. Update an existing memory before creating a new one when possible.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        `1. Write the memory to its own file in either \`${paths.autoMemoryDir}\` or \`${paths.teamMemoryDir}\`.`,
        `2. Add a pointer to that file in the directory entrypoint \`${ENTRYPOINT_NAME}\`. Each entry should be one short line: \`- [Title](file.md) — one-line hook\`. Never write the memory body directly into \`${ENTRYPOINT_NAME}\`.`,
        '',
        `Both \`${ENTRYPOINT_NAME}\` indexes are loaded into future context, so keep them concise and actively maintained.`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. Update an existing memory before creating a new one when possible.',
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

export class ActoviqMemoryApi {
  constructor(private readonly defaults: ActoviqMemoryOptions = {}) {}

  async paths(options: ActoviqMemoryOptions = {}): Promise<ActoviqMemoryPaths> {
    const store = await resolveActoviqSettingsStore({
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

  async getSettings(options: ActoviqMemoryOptions = {}): Promise<ActoviqMemorySettings> {
    const store = await resolveActoviqSettingsStore({
      configPath: options.configPath ?? this.defaults.configPath,
      homeDir: options.homeDir ?? this.defaults.homeDir,
    });
    return parseSettings(store.raw);
  }

  async updateSettings(
    patch: UpdateActoviqMemorySettingsInput,
    options: ActoviqMemoryOptions = {},
  ): Promise<ActoviqMemorySettings> {
    const store = await resolveActoviqSettingsStore({
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

    await persistActoviqSettingsStore(store.configPath, nextRaw);
    return parseSettings(nextRaw);
  }

  async buildCombinedPrompt(options: ActoviqMemoryPromptOptions = {}): Promise<string> {
    const paths = await this.paths(options);
    return buildCombinedMemoryPrompt(paths, options.extraGuidelines, options.skipIndex);
  }

  async buildPromptWithEntrypoints(options: ActoviqMemoryPromptOptions = {}): Promise<string> {
    const paths = await this.paths(options);
    const lines = [
      buildCombinedMemoryPrompt(paths, options.extraGuidelines, options.skipIndex),
    ];
    const entrypoints = [
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

  async scanMemoryFiles(options: ActoviqMemoryOptions = {}): Promise<ActoviqMemoryFileHeader[]> {
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

  async formatMemoryManifest(options: ActoviqMemoryOptions = {}): Promise<string> {
    return formatMemoryManifest(await this.scanMemoryFiles(options));
  }

  async findRelevantMemories(
    query: string,
    options: ActoviqRelevantMemoryLookupOptions = {},
  ): Promise<ActoviqRelevantMemory[]> {
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
    options: ActoviqRelevantMemoryLookupOptions = {},
  ): Promise<ActoviqSurfacedMemory[]> {
    const relevant = await this.findRelevantMemories(query, options);
    return readMemoriesForSurfacing(relevant);
  }

  async loadSessionTemplate(options: ActoviqMemoryOptions = {}): Promise<string> {
    const homeDir = options.homeDir ?? this.defaults.homeDir ?? os.homedir();
    const templatePath = path.join(homeDir, '.actoviq', 'session-memory', 'config', 'template.md');
    return (await readTextIfExists(templatePath)) ?? DEFAULT_SESSION_MEMORY_TEMPLATE;
  }

  async loadSessionPrompt(options: ActoviqMemoryOptions = {}): Promise<string> {
    const homeDir = options.homeDir ?? this.defaults.homeDir ?? os.homedir();
    const promptPath = path.join(homeDir, '.actoviq', 'session-memory', 'config', 'prompt.md');
    return (
      (await readTextIfExists(promptPath)) ??
      `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, ACTOVIQ.md entries, or any past session summaries), update the session notes file.

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
    options: ActoviqMemoryOptions = {},
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
    options: ActoviqMemoryOptions = {},
  ): Promise<string> {
    return `${await this.buildSessionUpdatePrompt(currentNotes, notesPath, options)}

You are running in direct-output mode, not tool-edit mode.

Return the FULL updated notes file as markdown only.
- Do not wrap the response in code fences
- Do not explain what you changed
- Preserve every existing section header and italic guide line exactly
- Only update the section bodies beneath those guides
- If a section has no meaningful updates, keep its existing content unchanged`;
  }

  async ensureSessionMemory(
    options: ActoviqMemoryOptions = {},
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
    options: ActoviqMemoryOptions = {},
  ): Promise<{ path: string; content: string }> {
    const ensured = await this.ensureSessionMemory(options);
    await writeFile(ensured.path, `${content.trim()}\n`, 'utf8');
    return {
      path: ensured.path,
      content: content.trim(),
    };
  }

  async isSessionMemoryEmpty(
    content: string,
    options: ActoviqMemoryOptions = {},
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

  async readSessionMemory(options: ActoviqMemoryOptions = {}): Promise<ActoviqSessionMemoryState> {
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

  getSessionMemoryConfig(): ActoviqSessionMemoryConfig {
    return {
      ...DEFAULT_SESSION_MEMORY_CONFIG,
    };
  }

  getSessionMemoryCompactConfig(): ActoviqSessionMemoryCompactConfig {
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
  }): ActoviqSessionMemoryProgress {
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
    const shouldExtract =
      initialized &&
      meetsUpdateThreshold === true &&
      (meetsToolCallThreshold === true || hasToolCallsInLastTurn === false);

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
    if (state.wasTruncated && options.includeFullMemoryPathHint !== false && paths.sessionMemoryPath) {
      summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${paths.sessionMemoryPath}`;
    }

    return buildCompactContinuationSummary(
      summaryContent,
      options.transcriptPath,
      options.recentMessagesPreserved ?? true,
    );
  }

  async compactState(options: ActoviqCompactStateOptions = {}): Promise<ActoviqCompactState> {
    const baseState = await this.state({
      ...options,
      includeSessionMemory: options.includeSessionMemory ?? true,
    });
    const sessionMemoryConfig = this.getSessionMemoryConfig();
    const sessionMemoryCompactConfig = this.getSessionMemoryCompactConfig();
    const sessionId = options.sessionId ?? this.defaults.sessionId;
    const transcriptPath =
      sessionId != null
        ? path.join(baseState.paths.projectStateDir, `${sessionId}.jsonl`)
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

    let boundaries: ActoviqTranscriptBoundary[] | undefined;
    let latestBoundary: ActoviqTranscriptBoundary | undefined;
    let compactCount = 0;
    let microcompactCount = 0;
    let lastSummarizedMessageUuid: string | undefined;
    let latestPreservedSegment: ActoviqPreservedSegment | undefined;
    let latestBoundarySummary: string | undefined;

    if (options.includeBoundaries !== false && sessionId) {
      boundaries = await getActoviqBridgeCompactBoundaries(sessionId, {
        dir: baseState.paths.projectPath,
        includeSystemMessages: true,
      });
      compactCount = boundaries.filter(boundary => boundary.kind === 'compact').length;
      microcompactCount = boundaries.filter(boundary => boundary.kind === 'microcompact').length;
      latestBoundary = boundaries.at(-1);
      const latestCompactBoundary = [...boundaries].reverse().find(boundary => boundary.kind === 'compact');
      lastSummarizedMessageUuid = latestCompactBoundary?.logicalParentUuid ?? undefined;
      latestPreservedSegment =
        latestCompactBoundary?.kind === 'compact'
          ? (latestCompactBoundary.metadata as ActoviqCompactBoundaryMetadata | undefined)
              ?.preservedSegment
          : undefined;
      latestBoundarySummary =
        latestBoundary?.kind === 'compact'
          ? getActoviqCompactBoundarySummary(
              latestBoundary.metadata as ActoviqCompactBoundaryMetadata | undefined,
            )
          : undefined;
    }

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

  async state(options: ActoviqMemoryStateOptions = {}): Promise<ActoviqMemoryState> {
    const store = await resolveActoviqSettingsStore({
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
      autoCompact: settings.autoCompactEnabled !== false,
      autoMemory: settings.autoMemoryEnabled !== false,
      autoDream: settings.autoDreamEnabled === true,
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

export function createActoviqMemoryApi(options: ActoviqMemoryOptions = {}): ActoviqMemoryApi {
  return new ActoviqMemoryApi(options);
}

export function getActoviqDefaultSessionMemoryTemplate(): string {
  return DEFAULT_SESSION_MEMORY_TEMPLATE;
}

export function getActoviqCompactBoundarySummary(
  metadata: ActoviqCompactBoundaryMetadata | undefined,
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
    metadata.preservedSegment
      ? `preservedSegment=${metadata.preservedSegment.headUuid}->${metadata.preservedSegment.anchorUuid}->${metadata.preservedSegment.tailUuid}`
      : undefined,
    metadata.userContext ? `userContext=${metadata.userContext}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function getActoviqDefaultSessionMemoryConfig(): ActoviqSessionMemoryConfig {
  return {
    ...DEFAULT_SESSION_MEMORY_CONFIG,
  };
}

export function getActoviqDefaultSessionMemoryCompactConfig(): ActoviqSessionMemoryCompactConfig {
  return {
    ...DEFAULT_SESSION_MEMORY_COMPACT_CONFIG,
  };
}

export {
  formatMemoryManifest as formatActoviqMemoryManifest,
  memoryAge as getActoviqMemoryAge,
  memoryAgeDays as getActoviqMemoryAgeDays,
  memoryFreshnessNote as getActoviqMemoryFreshnessNote,
  memoryFreshnessText as getActoviqMemoryFreshnessText,
  memoryHeader as getActoviqMemoryHeader,
  readMemoriesForSurfacing as readActoviqMemoriesForSurfacing,
  scanMemoryFiles as scanActoviqMemoryFiles,
  selectRelevantMemories as selectActoviqRelevantMemories,
};

export function getActoviqDefaultSettingsPath(options: { homeDir?: string } = {}): string {
  return getDefaultActoviqSettingsPath(options.homeDir);
}
