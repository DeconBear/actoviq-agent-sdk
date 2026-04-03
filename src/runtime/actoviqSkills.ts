import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MessageParam } from '../provider/types.js';
import type {
  ActoviqSkillContextMode,
  ActoviqSkillDefinition,
  ActoviqSkillDefinitionSummary,
  ActoviqSkillLoadedFrom,
  ActoviqSkillPromptBuildResult,
  ActoviqSkillPromptContext,
  ActoviqSkillSource,
  AgentRunOptions,
  AgentRunResult,
  SessionCreateOptions,
} from '../types.js';
import { deepClone, isRecord, truncateText } from './helpers.js';
import { AgentRunStream } from './asyncQueue.js';

const DEFAULT_BUNDLED_SKILLS: ReadonlyArray<ActoviqSkillDefinition> = [
  {
    name: 'debug',
    description: 'Investigate a problem systematically and gather evidence before proposing a fix.',
    whenToUse:
      'Use when a bug, failing test, broken workflow, or unclear runtime issue needs step-by-step diagnosis.',
    prompt: [
      'You are executing the /debug skill.',
      '',
      'Work systematically:',
      '1. Reproduce or narrow the issue.',
      '2. Gather concrete evidence with the available tools.',
      '3. Form a short ranked list of likely causes.',
      '4. Validate the strongest hypothesis first.',
      '5. Return the root cause, supporting evidence, and the safest next fix.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'simplify',
    description: 'Reduce unnecessary complexity in code, plans, or architecture while preserving behavior.',
    whenToUse:
      'Use when the current solution works but feels too complicated, repetitive, or hard to maintain.',
    prompt: [
      'You are executing the /simplify skill.',
      '',
      'Focus on the smallest simplification that meaningfully improves clarity or maintenance cost.',
      'Call out what can be removed, consolidated, or expressed more directly.',
      'Preserve behavior unless the user explicitly asks for a redesign.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'batch',
    description: 'Plan and execute related work in coherent batches instead of bouncing between tiny changes.',
    whenToUse:
      'Use when a task spans multiple related edits, checks, or files and would benefit from grouped execution.',
    prompt: [
      'You are executing the /batch skill.',
      '',
      'Group related investigation, edits, and verification into a few coherent passes.',
      'Avoid thrashing between unrelated files or repeatedly redoing the same check.',
      'Explain the batch structure briefly, then execute it.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'verify',
    description: 'Check whether a claim, change, or result is actually correct using available evidence.',
    whenToUse:
      'Use before finalizing risky changes, when confidence is low, or when a result needs explicit confirmation.',
    prompt: [
      'You are executing the /verify skill.',
      '',
      'Do not assume the result is correct. Verify it explicitly using the available tools, files, or tests.',
      'Report what was checked, what passed, what remains uncertain, and the current confidence level.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'remember',
    description: 'Capture durable project context that should survive the current turn or session.',
    whenToUse:
      'Use when the user shares stable preferences, workflow constraints, or recurring project knowledge worth preserving.',
    prompt: [
      'You are executing the /remember skill.',
      '',
      'Extract the durable facts, preferences, or workflow constraints that should be preserved.',
      'Keep the notes concise, factual, and directly useful for future work.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'stuck',
    description: 'Unblock a task by reframing the problem, narrowing the next step, and surfacing options.',
    whenToUse:
      'Use when progress has stalled, the search space is too broad, or the next move is unclear.',
    prompt: [
      'You are executing the /stuck skill.',
      '',
      'Reduce the problem to the next useful decision. Summarize what is known, what is blocking progress, and',
      'the smallest next action that will increase clarity. If helpful, provide two or three concrete options.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'loop',
    description: 'Run an iterative improve-check-adjust cycle until the task reaches a solid stopping point.',
    whenToUse:
      'Use for iterative work such as debugging, refinement, cleanup, or incremental verification.',
    prompt: [
      'You are executing the /loop skill.',
      '',
      'Work in short iterations: inspect, act, verify, and decide whether another loop is still useful.',
      'Stop when the task is complete, confidence is high, or the next loop would not add much value.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
  {
    name: 'update-config',
    description: 'Review and update local configuration safely, with a bias toward minimal changes and clear explanations.',
    whenToUse:
      'Use when changing SDK settings, runtime config, or repository-level configuration that affects future behavior.',
    prompt: [
      'You are executing the /update-config skill.',
      '',
      'Change configuration conservatively. Explain what changed, why it changed, and any follow-up effect the user',
      'should expect. Prefer the smallest safe edit that satisfies the request.',
      '',
      'Task:',
      '$ARGUMENTS',
    ].join('\n'),
    source: 'bundled',
    loadedFrom: 'bundled',
  },
];

interface LoadedSkillFile {
  definition: ActoviqSkillDefinition;
  filePath: string;
}

interface ActoviqSkillBindings<SessionLike> {
  listDefinitions: () => ActoviqSkillDefinitionSummary[];
  getDefinition: (skill: string) => ActoviqSkillDefinition | undefined;
  runDefinition: (
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  streamDefinition: (
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => AgentRunStream;
  runDefinitionOnSession: (
    session: SessionLike,
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  streamDefinitionOnSession: (
    session: SessionLike,
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => AgentRunStream;
}

export function skill(definition: ActoviqSkillDefinition): ActoviqSkillDefinition {
  return normalizeActoviqSkillDefinition(definition);
}

export function summarizeActoviqSkillDefinition(
  definition: ActoviqSkillDefinition,
): ActoviqSkillDefinitionSummary {
  const normalized = normalizeActoviqSkillDefinition(definition);
  return {
    name: normalized.name,
    description: normalized.description,
    whenToUse: normalized.whenToUse,
    argumentHint: normalized.argumentHint,
    argNames: [...(normalized.argNames ?? [])],
    model: normalized.model,
    source: normalized.source ?? 'custom',
    loadedFrom: normalized.loadedFrom ?? 'custom',
    context: normalized.context ?? 'inline',
    agent: normalized.agent,
    allowedTools: [...(normalized.allowedTools ?? [])],
    metadataKeys: Object.keys(normalized.metadata ?? {}),
    hasPrompt:
      (typeof normalized.prompt === 'string' && normalized.prompt.trim().length > 0) ||
      typeof normalized.buildPrompt === 'function',
    hasHooks:
      (normalized.hooks?.sessionStart?.length ?? 0) +
        (normalized.hooks?.postSampling?.length ?? 0) +
        (normalized.hooks?.postRun?.length ?? 0) >
      0,
    userInvocable: normalized.userInvocable !== false,
    disableModelInvocation: normalized.disableModelInvocation === true,
    skillRoot: normalized.skillRoot,
    paths: normalized.paths ? [...normalized.paths] : undefined,
  };
}

export class ActoviqSkillHandle<SessionLike> {
  constructor(
    private readonly bindings: ActoviqSkillBindings<SessionLike>,
    readonly name: string,
    private readonly defaults: AgentRunOptions = {},
  ) {}

  definition(): ActoviqSkillDefinition | undefined {
    return this.bindings.getDefinition(this.name);
  }

  metadata(): ActoviqSkillDefinitionSummary | undefined {
    return this.bindings.listDefinitions().find(definition => definition.name === this.name);
  }

  run(args = '', options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return this.bindings.runDefinition(this.name, args, {
      ...this.defaults,
      ...options,
    });
  }

  stream(args = '', options: AgentRunOptions = {}): AgentRunStream {
    return this.bindings.streamDefinition(this.name, args, {
      ...this.defaults,
      ...options,
    });
  }

  runInSession(
    session: SessionLike,
    args = '',
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runDefinitionOnSession(session, this.name, args, {
      ...this.defaults,
      ...options,
    });
  }

  streamInSession(session: SessionLike, args = '', options: AgentRunOptions = {}): AgentRunStream {
    return this.bindings.streamDefinitionOnSession(session, this.name, args, {
      ...this.defaults,
      ...options,
    });
  }
}

export class ActoviqSkillsApi<SessionLike> {
  constructor(private readonly bindings: ActoviqSkillBindings<SessionLike>) {}

  list(): ActoviqSkillDefinitionSummary[] {
    return this.bindings.listDefinitions();
  }

  listMetadata(): ActoviqSkillDefinitionSummary[] {
    return this.bindings.listDefinitions();
  }

  get(name: string): ActoviqSkillDefinition | undefined {
    return this.bindings.getDefinition(name);
  }

  getMetadata(name: string): ActoviqSkillDefinitionSummary | undefined {
    return this.bindings.listDefinitions().find(definition => definition.name === name);
  }

  use(name: string, defaults: AgentRunOptions = {}): ActoviqSkillHandle<SessionLike> {
    return new ActoviqSkillHandle(this.bindings, name, defaults);
  }

  run(name: string, args = '', options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return this.bindings.runDefinition(name, args, options);
  }

  stream(name: string, args = '', options: AgentRunOptions = {}): AgentRunStream {
    return this.bindings.streamDefinition(name, args, options);
  }

  runInSession(
    session: SessionLike,
    name: string,
    args = '',
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runDefinitionOnSession(session, name, args, options);
  }

  streamInSession(
    session: SessionLike,
    name: string,
    args = '',
    options: AgentRunOptions = {},
  ): AgentRunStream {
    return this.bindings.streamDefinitionOnSession(session, name, args, options);
  }
}

export function getDefaultActoviqBundledSkills(): ActoviqSkillDefinition[] {
  return DEFAULT_BUNDLED_SKILLS.map(normalizeActoviqSkillDefinition);
}

export async function loadActoviqSkillDefinitions(options: {
  homeDir: string;
  workDir: string;
  skillDirectories?: string[];
  disableDefaultSkills?: boolean;
  loadDefaultSkillDirectories?: boolean;
}): Promise<ActoviqSkillDefinition[]> {
  const loaded: ActoviqSkillDefinition[] = [];

  if (!options.disableDefaultSkills) {
    loaded.push(...getDefaultActoviqBundledSkills());
  }

  const directories: Array<{
    path: string;
    source: ActoviqSkillSource;
    loadedFrom: ActoviqSkillLoadedFrom;
  }> = [];

  if (options.loadDefaultSkillDirectories !== false) {
    directories.push(
      {
        path: path.join(options.homeDir, 'skills'),
        source: 'user',
        loadedFrom: 'skills',
      },
      {
        path: path.join(options.workDir, '.actoviq', 'skills'),
        source: 'project',
        loadedFrom: 'skills',
      },
      {
        path: path.join(options.workDir, '.actoviq', 'commands'),
        source: 'project',
        loadedFrom: 'commands',
      },
    );
  }

  for (const directory of options.skillDirectories ?? []) {
    directories.push({
      path: directory,
      source: 'project',
      loadedFrom: 'skills',
    });
  }

  for (const directory of directories) {
    const nextDefinitions =
      directory.loadedFrom === 'commands'
        ? await loadActoviqCommandSkills(directory.path, directory.source)
        : await loadActoviqSkillsDirectory(directory.path, directory.source);
    loaded.push(...nextDefinitions.map(entry => entry.definition));
  }

  const merged = new Map<string, ActoviqSkillDefinition>();
  for (const definition of loaded) {
    merged.set(definition.name, normalizeActoviqSkillDefinition(definition));
  }

  return [...merged.values()];
}

export async function resolveActoviqSkillPrompt(
  definition: ActoviqSkillDefinition,
  args: string,
  context: ActoviqSkillPromptContext,
): Promise<ActoviqSkillPromptBuildResult> {
  const normalized = normalizeActoviqSkillDefinition(definition);
  const result = normalized.buildPrompt
    ? await normalized.buildPrompt(args, context)
    : normalized.prompt ?? args;

  const normalizedResult = normalizeSkillPromptResult(result);
  const content = normalizeSkillPromptContent(
    normalizedResult.content,
    normalized,
    args,
    context,
  );

  return {
    content,
    systemPromptParts: normalizedResult.systemPromptParts
      ? [...normalizedResult.systemPromptParts]
      : undefined,
    metadata: normalizedResult.metadata ? { ...normalizedResult.metadata } : undefined,
  };
}

function normalizeActoviqSkillDefinition(definition: ActoviqSkillDefinition): ActoviqSkillDefinition {
  return {
    ...definition,
    argNames: definition.argNames ? [...definition.argNames] : undefined,
    hooks: definition.hooks
      ? {
          sessionStart: definition.hooks.sessionStart ? [...definition.hooks.sessionStart] : undefined,
          postSampling: definition.hooks.postSampling ? [...definition.hooks.postSampling] : undefined,
          postRun: definition.hooks.postRun ? [...definition.hooks.postRun] : undefined,
        }
      : undefined,
    metadata: definition.metadata ? deepClone(definition.metadata) : undefined,
    tools: definition.tools ? [...definition.tools] : undefined,
    mcpServers: definition.mcpServers ? deepClone(definition.mcpServers) : undefined,
    allowedTools: definition.allowedTools ? [...definition.allowedTools] : undefined,
    paths: definition.paths ? [...definition.paths] : undefined,
    context: definition.context ?? 'inline',
    source: definition.source ?? 'custom',
    loadedFrom: definition.loadedFrom ?? 'custom',
    userInvocable: definition.userInvocable ?? true,
    disableModelInvocation: definition.disableModelInvocation ?? false,
  };
}

function normalizeSkillPromptResult(
  result: string | MessageParam['content'] | ActoviqSkillPromptBuildResult,
): ActoviqSkillPromptBuildResult {
  if (typeof result === 'string' || Array.isArray(result)) {
    return {
      content: deepClone(result),
    };
  }

  return {
    content: deepClone(result.content),
    systemPromptParts: result.systemPromptParts ? [...result.systemPromptParts] : undefined,
    metadata: result.metadata ? deepClone(result.metadata) : undefined,
  };
}

function normalizeSkillPromptContent(
  content: MessageParam['content'],
  definition: ActoviqSkillDefinition,
  args: string,
  context: ActoviqSkillPromptContext,
): MessageParam['content'] {
  if (typeof content === 'string') {
    return interpolateSkillTemplate(content, args, definition, context, true);
  }

  return content.map(block => {
    if (!isRecord(block)) {
      return block;
    }
    if (block.type !== 'text' || typeof block.text !== 'string') {
      return block;
    }
    return {
      ...block,
      text: interpolateSkillTemplate(block.text, args, definition, context, false),
    };
  }) as MessageParam['content'];
}

function interpolateSkillTemplate(
  value: string,
  args: string,
  definition: ActoviqSkillDefinition,
  context: ActoviqSkillPromptContext,
  prependBaseDir: boolean,
): string {
  const trimmedArgs = args.trim();
  const argValues = splitArgumentValues(trimmedArgs);
  let next = value
    .replace(/\$ARGUMENTS\b/gu, trimmedArgs)
    .replace(/\$\{ACTOVIQ_SKILL_ARGS\}/gu, trimmedArgs)
    .replace(/\$\{ACTOVIQ_SESSION_ID\}/gu, context.sessionId ?? '')
    .replace(/\$\{ACTOVIQ_SKILL_DIR\}/gu, normalizeSkillDir(definition.skillRoot));

  for (const [index, token] of argValues.entries()) {
    next = next.replace(new RegExp(`\\$\\{${index + 1}\\}`, 'gu'), token);
  }

  for (const [index, argName] of (definition.argNames ?? []).entries()) {
    const replacement = argValues[index] ?? '';
    next = next.replace(new RegExp(`\\$\\{${escapeRegExp(argName)}\\}`, 'gu'), replacement);
  }

  if (prependBaseDir && definition.skillRoot) {
    next = `Base directory for this skill: ${normalizeSkillDir(definition.skillRoot)}\n\n${next}`;
  }

  return next;
}

function normalizeSkillDir(skillRoot: string | undefined): string {
  if (!skillRoot) {
    return '';
  }
  return process.platform === 'win32' ? skillRoot.replace(/\\/gu, '/') : skillRoot;
}

function splitArgumentValues(input: string): string[] {
  if (!input) {
    return [];
  }

  const values: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/iu.test(character)) {
      if (current) {
        values.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current) {
    values.push(current);
  }

  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function loadActoviqSkillsDirectory(
  rootDir: string,
  source: ActoviqSkillSource,
): Promise<LoadedSkillFile[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map(async entry => {
      if (!entry.isDirectory()) {
        return null;
      }
      const skillRoot = path.join(rootDir, entry.name);
      const skillPath = path.join(skillRoot, 'SKILL.md');
      try {
        const content = await readFile(skillPath, 'utf8');
        const parsed = parseMarkdownFrontmatter(content);
        const name = entry.name;
        return {
          definition: createDiskSkillDefinition({
            name,
            content: parsed.body,
            frontmatter: parsed.frontmatter,
            source,
            loadedFrom: 'skills',
            skillRoot,
          }),
          filePath: skillPath,
        } satisfies LoadedSkillFile;
      } catch {
        return null;
      }
    }),
  );

  return loaded.filter((entry): entry is LoadedSkillFile => entry !== null);
}

async function loadActoviqCommandSkills(
  rootDir: string,
  source: ActoviqSkillSource,
): Promise<LoadedSkillFile[]> {
  const markdownFiles = await walkMarkdownFiles(rootDir);
  const loaded = await Promise.all(
    markdownFiles.map(async filePath => {
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = parseMarkdownFrontmatter(raw);
        const name = deriveCommandSkillName(rootDir, filePath);
        return {
          definition: createDiskSkillDefinition({
            name,
            content: parsed.body,
            frontmatter: parsed.frontmatter,
            source,
            loadedFrom: 'commands',
            skillRoot: path.basename(filePath).toUpperCase() === 'SKILL.MD' ? path.dirname(filePath) : undefined,
          }),
          filePath,
        } satisfies LoadedSkillFile;
      } catch {
        return null;
      }
    }),
  );

  return loaded.filter((entry): entry is LoadedSkillFile => entry !== null);
}

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async entry => {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          results.push(fullPath);
        }
      }),
    );
  }

  await visit(rootDir);
  return collapseSkillMarkdownFiles(results);
}

function collapseSkillMarkdownFiles(files: string[]): string[] {
  const byDirectory = new Map<string, string[]>();
  for (const filePath of files) {
    const directory = path.dirname(filePath);
    const existing = byDirectory.get(directory) ?? [];
    existing.push(filePath);
    byDirectory.set(directory, existing);
  }

  const result: string[] = [];
  for (const [directory, directoryFiles] of byDirectory) {
    const skillFile = directoryFiles.find(filePath => path.basename(filePath).toUpperCase() === 'SKILL.MD');
    if (skillFile) {
      result.push(skillFile);
      continue;
    }
    result.push(...directoryFiles);
  }

  return result;
}

function deriveCommandSkillName(rootDir: string, filePath: string): string {
  if (path.basename(filePath).toUpperCase() === 'SKILL.MD') {
    const skillDirectory = path.dirname(filePath);
    const relativeDirectory = path.relative(rootDir, skillDirectory);
    return relativeDirectory.split(path.sep).filter(Boolean).join(':');
  }

  const relativePath = path.relative(rootDir, filePath).replace(/\.md$/iu, '');
  return relativePath.split(path.sep).filter(Boolean).join(':');
}

function createDiskSkillDefinition(input: {
  name: string;
  content: string;
  frontmatter: Record<string, string>;
  source: ActoviqSkillSource;
  loadedFrom: ActoviqSkillLoadedFrom;
  skillRoot?: string;
}): ActoviqSkillDefinition {
  const description =
    input.frontmatter.description?.trim() ||
    extractDescriptionFromMarkdown(input.content) ||
    `Run the ${input.name} skill.`;

  const argNames = parseDelimitedField(input.frontmatter.arguments);
  const prompt = input.content.trim();

  return normalizeActoviqSkillDefinition({
    name: input.name,
    description,
    whenToUse: input.frontmatter.when_to_use?.trim() || undefined,
    argumentHint: input.frontmatter['argument-hint']?.trim() || undefined,
    argNames: argNames.length > 0 ? argNames : undefined,
    prompt,
    model: input.frontmatter.model?.trim() || undefined,
    disableModelInvocation: parseBooleanField(input.frontmatter['disable-model-invocation']),
    userInvocable:
      input.frontmatter['user-invocable'] == null
        ? true
        : parseBooleanField(input.frontmatter['user-invocable']),
    source: input.source,
    loadedFrom: input.loadedFrom,
    context: input.frontmatter.context === 'fork' ? 'fork' : 'inline',
    agent: input.frontmatter.agent?.trim() || undefined,
    allowedTools: parseDelimitedField(input.frontmatter['allowed-tools']),
    paths: parseDelimitedField(input.frontmatter.paths),
    skillRoot: input.skillRoot,
  });
}

function parseMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = content.split(/\r?\n/iu);
  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const frontmatter: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '---') {
      index += 1;
      break;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  return {
    frontmatter,
    body: lines.slice(index).join('\n').trim(),
  };
}

function parseDelimitedField(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\n,]/u)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function parseBooleanField(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(1|true|yes|on)$/iu.test(value.trim());
}

function extractDescriptionFromMarkdown(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/iu)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/^#+\s*/u, '').trim();
    if (!normalized) {
      continue;
    }
    if (normalized.length <= 120) {
      return normalized;
    }
    return truncateText(normalized, 120);
  }

  return undefined;
}
