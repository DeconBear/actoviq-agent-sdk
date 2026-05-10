import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createActoviqBuddyApi, type ActoviqBuddyApi } from '../buddy/actoviqBuddy.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import { ActoviqBridgeProcessError, RunAbortedError } from '../errors.js';
import { createActoviqMemoryApi, type ActoviqMemoryApi } from '../memory/actoviqMemory.js';
import { AsyncQueue } from '../runtime/asyncQueue.js';
import { asError, isRecord } from '../runtime/helpers.js';
import type {
  ActoviqAgentMetadata,
  ActoviqAgentSummary,
  ActoviqBridgeAgentRunOptions,
  ActoviqBridgeAgentSessionOptions,
  ActoviqBridgeCapabilityLookupOptions,
  ActoviqContextUsage,
  ActoviqBridgeJsonEvent,
  ActoviqBridgeRunOptions,
  ActoviqBridgeRunResult,
  ActoviqBridgeSkillRunOptions,
  ActoviqRuntimeCatalog,
  ActoviqRuntimeInfo,
  ActoviqSkillMetadata,
  ActoviqSlashCommandMetadata,
  ActoviqBridgeSessionCreateOptions,
  ActoviqToolMetadata,
  CreateActoviqBridgeSdkOptions,
} from '../types.js';
import {
  getActoviqBridgeCompactBoundaries,
  getActoviqBridgeLatestCompactBoundary,
  getActoviqBridgeSessionInfo,
  getActoviqBridgeSessionMessages,
  listActoviqBridgeSessions,
} from './actoviqTranscripts.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

function isAbortErrorLike(error: unknown): boolean {
  return error instanceof RunAbortedError || (error instanceof Error && error.name === 'AbortError');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, IS_WINDOWS ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPathEnv(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue.split(path.delimiter).filter(Boolean);
}

async function findExecutableOnPath(name: string): Promise<string | undefined> {
  const pathDirectories = splitPathEnv(process.env.PATH);
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];

  for (const directory of pathDirectories) {
    const directCandidate = path.join(directory, name);
    if (!IS_WINDOWS && (await isExecutable(directCandidate))) {
      return directCandidate;
    }

    for (const extension of extensions) {
      const candidate = directCandidate.endsWith(extension.toLowerCase())
        ? directCandidate
        : `${directCandidate}${extension.toLowerCase()}`;
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function findFirstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function resolveBunExecutable(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    if (!(await isExecutable(explicitPath))) {
      throw new ActoviqBridgeProcessError(
        `The configured executable was not found or is not executable: ${explicitPath}`,
      );
    }
    return explicitPath;
  }

  const localCandidate = await findFirstExistingPath([
    ...(IS_WINDOWS
      ? [
          path.resolve(MODULE_DIR, '..', '..', 'node_modules', 'bun', 'bin', 'bun.exe'),
          path.resolve(MODULE_DIR, '..', '..', '..', 'node_modules', 'bun', 'bin', 'bun.exe'),
          path.resolve(process.cwd(), 'node_modules', 'bun', 'bin', 'bun.exe'),
        ]
      : []),
    path.resolve(MODULE_DIR, '..', '..', 'node_modules', '.bin', `bun${IS_WINDOWS ? '.cmd' : ''}`),
    path.resolve(
      MODULE_DIR,
      '..',
      '..',
      '..',
      'node_modules',
      '.bin',
      `bun${IS_WINDOWS ? '.cmd' : ''}`,
    ),
    path.resolve(process.cwd(), 'node_modules', '.bin', `bun${IS_WINDOWS ? '.cmd' : ''}`),
  ]);
  if (localCandidate) {
    return localCandidate;
  }

  const pathCandidate = await findExecutableOnPath('bun');
  if (pathCandidate) {
    return pathCandidate;
  }

  throw new ActoviqBridgeProcessError(
    'Bun is required for the Actoviq Runtime bridge, but no bun executable was found. Install Bun or pass { executable }.',
  );
}

async function resolveActoviqRuntimeCliPath(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    if (!(await pathExists(explicitPath))) {
      throw new ActoviqBridgeProcessError(`Actoviq Runtime CLI entry was not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const resolved = await findFirstExistingPath([
    path.resolve(MODULE_DIR, '..', '..', 'vendor', 'actoviq-runtime', 'cli.js'),
    path.resolve(MODULE_DIR, '..', '..', '..', 'vendor', 'actoviq-runtime', 'cli.js'),
    path.resolve(process.cwd(), 'vendor', 'actoviq-runtime', 'cli.js'),
  ]);

  if (!resolved) {
    throw new ActoviqBridgeProcessError(
      'Actoviq Runtime CLI entry was not found. Run npm run sync:actoviq-runtime or pass { cliPath } explicitly.',
    );
  }

  return resolved;
}

function stringifyCliValue(value: string | Record<string, unknown>): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeToolsArgument(tools: CreateActoviqBridgeSdkOptions['tools']): string | undefined {
  if (tools == null) {
    return undefined;
  }
  if (tools === 'default') {
    return 'default';
  }
  if (tools === 'none') {
    return '';
  }
  return tools.join(',');
}

function appendRepeatableArgs(args: string[], flag: string, values?: string[]): void {
  if (!values?.length) {
    return;
  }
  args.push(flag, ...values);
}

function appendOptionalArg(args: string[], flag: string, value: string | number | undefined): void {
  if (value == null || value === '') {
    return;
  }
  args.push(flag, String(value));
}

function getStringValue(event: ActoviqBridgeJsonEvent | undefined, key: string): string | undefined {
  const value = event?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberValue(event: ActoviqBridgeJsonEvent | undefined, key: string): number | undefined {
  const value = event?.[key];
  return typeof value === 'number' ? value : undefined;
}

function getBooleanValue(event: ActoviqBridgeJsonEvent | undefined, key: string): boolean | undefined {
  const value = event?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function extractAssistantText(event: ActoviqBridgeJsonEvent): string {
  const message = event.message;
  if (!isRecord(message)) {
    return '';
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(block => {
      if (!isRecord(block)) {
        return '';
      }
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

function deriveResultText(
  resultEvent: ActoviqBridgeJsonEvent | undefined,
  assistantMessages: ActoviqBridgeJsonEvent[],
): string {
  const rawResult = resultEvent?.result;
  if (typeof rawResult === 'string') {
    return rawResult;
  }

  for (let index = assistantMessages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantText(assistantMessages[index]!);
    if (text) {
      return text;
    }
  }

  return '';
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function getObjectArray<T extends Record<string, unknown>>(value: unknown): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is T => isRecord(entry));
}

function parseMarkdownTable(markdown: string, heading: string): Array<Record<string, string>> {
  const headingIndex = markdown.indexOf(`### ${heading}`);
  if (headingIndex === -1) {
    return [];
  }

  const afterHeading = markdown.slice(headingIndex).split(/\r?\n/).slice(1);
  const tableLines: string[] = [];
  for (const line of afterHeading) {
    if (line.startsWith('### ')) {
      break;
    }
    if (line.trim().startsWith('|')) {
      tableLines.push(line.trim());
      continue;
    }
    if (tableLines.length > 0 && !line.trim()) {
      break;
    }
  }

  if (tableLines.length < 3) {
    return [];
  }

  const headers = tableLines[0]!
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);
  const rows = tableLines.slice(2);

  return rows.map(row => {
    const cells = row
      .split('|')
      .map(cell => cell.trim())
      .filter(Boolean);
    return Object.fromEntries(
      headers.map((header, index) => [header, cells[index] ?? '']),
    );
  });
}

function parseActoviqContextUsageResult(result: ActoviqBridgeRunResult): ActoviqContextUsage {
  const markdown = result.text;
  const modelMatch = markdown.match(/\*\*Model:\*\*\s+([^\r\n]+)/u);
  const tokensMatch = markdown.match(
    /\*\*Tokens:\*\*\s+(.+?)\s+\/\s+(.+?)\s+\(([\d.]+)%\)/u,
  );

  return {
    markdown,
    model: modelMatch?.[1]?.trim(),
    tokensUsed: tokensMatch?.[1]?.trim(),
    tokenLimit: tokensMatch?.[2]?.trim(),
    percentage: tokensMatch?.[3] ? Number(tokensMatch[3]) : undefined,
    categories: parseMarkdownTable(markdown, 'Estimated usage by category').map(row => ({
      name: row.Category ?? '',
      tokens: row.Tokens ?? '',
      percentage: row.Percentage ?? '',
    })),
    skills: parseMarkdownTable(markdown, 'Skills').map(row => ({
      name: row.Skill ?? '',
      source: row.Source || undefined,
      tokens: row.Tokens ?? '',
    })),
    agents: parseMarkdownTable(markdown, 'Custom Agents').map(row => ({
      agentType: row['Agent Type'] ?? '',
      source: row.Source || undefined,
      tokens: row.Tokens ?? '',
    })),
    mcpTools: parseMarkdownTable(markdown, 'MCP Tools').map(row => ({
      tool: row.Tool ?? '',
      server: row.Server ?? '',
      tokens: row.Tokens ?? '',
    })),
    rawResult: result,
  };
}

function runtimeInfoFromInitEvent(initEvent: ActoviqBridgeJsonEvent): ActoviqRuntimeInfo {
  return {
    sessionId: getStringValue(initEvent, 'session_id') ?? '',
    cwd: getStringValue(initEvent, 'cwd'),
    model: getStringValue(initEvent, 'model'),
    permissionMode: getStringValue(initEvent, 'permissionMode'),
    tools: getStringArray(initEvent.tools),
    mcpServers: getObjectArray<Record<string, unknown>>(initEvent.mcp_servers).map(server => ({
      name: typeof server.name === 'string' ? server.name : '',
      status: typeof server.status === 'string' ? server.status : undefined,
    })),
    slashCommands: getStringArray(initEvent.slash_commands),
    agents: getStringArray(initEvent.agents),
    skills: getStringArray(initEvent.skills),
    plugins: getObjectArray<Record<string, unknown>>(initEvent.plugins).map(plugin => ({
      name: typeof plugin.name === 'string' ? plugin.name : '',
      path: typeof plugin.path === 'string' ? plugin.path : undefined,
      source: typeof plugin.source === 'string' ? plugin.source : undefined,
    })),
    rawInitEvent: structuredClone(initEvent),
  };
}

function parseActoviqAgentSummaryOutput(stdout: string): ActoviqAgentSummary[] {
  const agents: ActoviqAgentSummary[] = [];
  let currentGroup = 'Unknown';

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+\s+active\s+agents$/u.test(trimmed)) {
      continue;
    }
    if (trimmed.endsWith(':')) {
      currentGroup = trimmed.slice(0, -1);
      continue;
    }

    let active = true;
    let shadowedBy: string | undefined;
    let descriptor = trimmed;

    const shadowedMatch = trimmed.match(/^\(shadowed by ([^)]+)\)\s+(.+)$/u);
    if (shadowedMatch) {
      active = false;
      shadowedBy = shadowedMatch[1]?.trim();
      descriptor = shadowedMatch[2] ?? trimmed;
    }

    const parts = descriptor.split(/\s+·\s+/u).map(part => part.trim()).filter(Boolean);
    const name = parts.shift();
    if (!name) {
      continue;
    }

    let model: string | undefined;
    let memory: string | undefined;
    for (const part of parts) {
      if (part.endsWith(' memory')) {
        memory = part.replace(/ memory$/u, '');
      } else if (!model) {
        model = part;
      }
    }

    agents.push({
      name,
      sourceGroup: currentGroup,
      active,
      rawLine: trimmed,
      model,
      memory,
      shadowedBy,
    });
  }

  return agents;
}

function formatSlashCommand(commandName: string, args = ''): string {
  const normalizedName = commandName.trim().replace(/^\/+/u, '');
  const normalizedArgs = args.trim();
  return normalizedArgs ? `/${normalizedName} ${normalizedArgs}` : `/${normalizedName}`;
}

function buildRuntimeCatalog(params: {
  runtime: ActoviqRuntimeInfo;
  agents: ActoviqAgentSummary[];
  context?: ActoviqContextUsage;
}): ActoviqRuntimeCatalog {
  const { runtime, agents, context } = params;
  const contextSkillMap = new Map(context?.skills.map(skill => [skill.name, skill]) ?? []);
  const contextAgentMap = new Map(context?.agents.map(agent => [agent.agentType, agent]) ?? []);
  const contextMcpToolMap = new Map(context?.mcpTools.map(tool => [tool.tool, tool]) ?? []);
  const skillNames = new Set(runtime.skills);

  const tools: ActoviqToolMetadata[] = runtime.tools.map(name => {
    const contextTool = contextMcpToolMap.get(name);
    return {
      name,
      kind: contextTool ? 'mcp' : 'builtin',
      server: contextTool?.server,
      tokens: contextTool?.tokens,
    };
  });

  const skills: ActoviqSkillMetadata[] = runtime.skills.map(name => {
    const contextSkill = contextSkillMap.get(name);
    return {
      name,
      slashCommand: `/${name}`,
      source: contextSkill?.source,
      tokens: contextSkill?.tokens,
    };
  });

  const slashCommands: ActoviqSlashCommandMetadata[] = runtime.slashCommands.map(name => ({
    name,
    kind: skillNames.has(name) ? 'skill' : 'builtin',
    skillName: skillNames.has(name) ? name : undefined,
  }));

  const enrichedAgents: ActoviqAgentMetadata[] = agents.map(agent => {
    const contextAgent = contextAgentMap.get(agent.name);
    return {
      ...agent,
      contextSource: contextAgent?.source,
      tokens: contextAgent?.tokens,
    };
  });

  return {
    runtime,
    agents: enrichedAgents,
    tools,
    skills,
    slashCommands,
    context,
  };
}

function buildCliArgs(prompt: string, options: ActoviqBridgeRunOptions): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (options.includePartialMessages ?? true) {
    args.push('--include-partial-messages');
  }
  if (options.includeHookEvents) {
    args.push('--include-hook-events');
  }
  if (options.bare) {
    args.push('--bare');
  }
  if (options.disableSlashCommands) {
    args.push('--disable-slash-commands');
  }
  if (options.strictMcpConfig) {
    args.push('--strict-mcp-config');
  }
  if (options.continueMostRecent) {
    args.push('--continue');
  }
  if (options.forkSession) {
    args.push('--fork-session');
  }

  const shouldSkipPermissions =
    options.dangerouslySkipPermissions ??
    (options.permissionMode == null || options.permissionMode === 'bypassPermissions');
  if (shouldSkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  appendOptionalArg(args, '--permission-mode', options.permissionMode);
  appendOptionalArg(args, '--model', options.model);
  appendOptionalArg(args, '--fallback-model', options.fallbackModel);
  appendOptionalArg(args, '--effort', options.effort);
  appendOptionalArg(args, '--system-prompt', options.systemPrompt);
  appendOptionalArg(args, '--append-system-prompt', options.appendSystemPrompt);
  appendOptionalArg(args, '--max-turns', options.maxTurns);
  appendOptionalArg(args, '--max-budget-usd', options.maxBudgetUsd);
  appendOptionalArg(args, '--agent', options.agent);
  appendOptionalArg(args, '-n', options.name);
  appendOptionalArg(args, '--setting-sources', options.settingSources);

  if (options.jsonSchema != null) {
    args.push('--json-schema', stringifyCliValue(options.jsonSchema));
  }
  if (options.settings != null) {
    args.push('--settings', stringifyCliValue(options.settings));
  }
  if (options.agents != null) {
    args.push('--agents', JSON.stringify(options.agents));
  }

  const toolsArg = normalizeToolsArgument(options.tools);
  if (toolsArg != null) {
    args.push('--tools', toolsArg);
  }
  if (options.allowedTools?.length) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }
  if (options.disallowedTools?.length) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }

  appendRepeatableArgs(args, '--add-dir', options.addDirs);
  appendRepeatableArgs(args, '--plugin-dir', options.pluginDirs);
  appendRepeatableArgs(args, '--file', options.files);

  if (options.mcpConfigs?.length) {
    args.push(
      '--mcp-config',
      ...options.mcpConfigs.map(config => stringifyCliValue(config)),
    );
  }

  if (typeof options.resume === 'string') {
    args.push('--resume', options.resume);
  } else if (options.resume === true) {
    args.push('--resume');
  } else if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }

  if (options.cliArgs?.length) {
    args.push(...options.cliArgs);
  }

  return args;
}

function buildChildEnvironment(envOverrides?: Record<string, string>): Record<string, string> {
  const loadedConfig = getLoadedJsonConfig();
  const mergedEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...(loadedConfig?.env ?? {}),
    ...(envOverrides ?? {}),
  };

  return mergedEnv;
}

async function prefersSystemRipgrep(envOverrides?: Record<string, string>): Promise<boolean> {
  const explicit = envOverrides?.USE_BUILTIN_RIPGREP ?? process.env.USE_BUILTIN_RIPGREP;
  if (explicit != null) {
    return false;
  }
  return Boolean(await findExecutableOnPath('rg'));
}

async function parseStdoutEvents(
  child: ReturnType<typeof spawn>,
  onEvent: (event: ActoviqBridgeJsonEvent) => void,
): Promise<void> {
  if (!child.stdout) {
    return;
  }

  const stream = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of stream) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ActoviqBridgeProcessError(`Failed to parse Actoviq Runtime stream line: ${trimmed}`, {
        cause: error,
      });
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      throw new ActoviqBridgeProcessError('Actoviq Runtime emitted a malformed stream event.');
    }

    onEvent(parsed as ActoviqBridgeJsonEvent);
  }
}

async function readStderr(child: ReturnType<typeof spawn>): Promise<string> {
  if (!child.stderr) {
    return '';
  }

  let stderr = '';
  for await (const chunk of child.stderr) {
    stderr += chunk.toString();
  }
  return stderr;
}

async function readStdout(child: ReturnType<typeof spawn>): Promise<string> {
  if (!child.stdout) {
    return '';
  }

  let stdout = '';
  for await (const chunk of child.stdout) {
    stdout += chunk.toString();
  }
  return stdout;
}

export class ActoviqBridgeRunStream implements AsyncIterable<ActoviqBridgeJsonEvent> {
  private readonly queue = new AsyncQueue<ActoviqBridgeJsonEvent>();
  readonly result: Promise<ActoviqBridgeRunResult>;

  constructor(
    executor: (controller: {
      emit: (event: ActoviqBridgeJsonEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    }) => Promise<ActoviqBridgeRunResult>,
  ) {
    this.result = (async () => {
      try {
        return await executor({
          emit: event => this.queue.push(event),
          fail: error => this.queue.fail(error),
          close: () => this.queue.close(),
        });
      } catch (error) {
        this.queue.fail(error);
        throw error;
      } finally {
        this.queue.close();
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}

export class ActoviqBridgeSession {
  private started: boolean;

  constructor(
    private readonly client: ActoviqBridgeSdkClient,
    readonly id: string,
    readonly title: string | undefined,
    private readonly defaults: ActoviqBridgeSessionCreateOptions,
    started = false,
  ) {
    this.started = started;
  }

  async send(prompt: string, options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<ActoviqBridgeRunResult> {
    const result = await this.client.run(prompt, this.buildRunOptions(options));
    this.started = true;
    return result;
  }

  stream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    const runStream = this.client.stream(prompt, this.buildRunOptions(options));
    void runStream.result.then(
      () => {
        this.started = true;
      },
      () => undefined,
    );
    return runStream;
  }

  runSlashCommand(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.send(formatSlashCommand(commandName, args), options);
  }

  runSkill(
    skill: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.runSlashCommand(skill, args, options);
  }

  streamSlashCommand(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return this.stream(formatSlashCommand(commandName, args), options);
  }

  streamSkill(
    skill: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return this.streamSlashCommand(skill, args, options);
  }

  compact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.runSlashCommand('compact', args, options);
  }

  info(options?: Parameters<typeof getActoviqBridgeSessionInfo>[1]) {
    return getActoviqBridgeSessionInfo(this.id, options);
  }

  messages(options?: Parameters<typeof getActoviqBridgeSessionMessages>[1]) {
    return getActoviqBridgeSessionMessages(this.id, options);
  }

  compactBoundaries(options?: Parameters<typeof getActoviqBridgeCompactBoundaries>[1]) {
    return getActoviqBridgeCompactBoundaries(this.id, options);
  }

    latestCompactBoundary(
      options?: Parameters<typeof getActoviqBridgeLatestCompactBoundary>[1],
    ) {
      return getActoviqBridgeLatestCompactBoundary(this.id, options);
    }

    compactState(
      options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {},
    ) {
      return this.client.memory.compactState({
        ...options,
        sessionId: this.id,
      });
    }

  fork(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.run(prompt, {
      ...this.defaults,
      ...options,
      resume: this.id,
      forkSession: true,
    });
  }

  forkStream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return this.client.stream(prompt, {
      ...this.defaults,
      ...options,
      resume: this.id,
      forkSession: true,
    });
  }

  private buildRunOptions(options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>): ActoviqBridgeRunOptions {
    const merged: ActoviqBridgeRunOptions = {
      ...this.defaults,
      ...options,
      name: options.name ?? this.title,
    };

    if (this.started) {
      merged.resume = this.id;
    } else {
      merged.sessionId = this.id;
    }

    return merged;
  }
}

export class ActoviqBridgeAgentHandle {
  constructor(
    private readonly client: ActoviqBridgeSdkClient,
    readonly agent: string,
    private readonly defaults: ActoviqBridgeAgentRunOptions = {},
  ) {}

  run(prompt: string, options: ActoviqBridgeAgentRunOptions = {}): Promise<ActoviqBridgeRunResult> {
    return this.client.run(prompt, {
      ...this.defaults,
      ...options,
      agent: this.agent,
    });
  }

  stream(prompt: string, options: ActoviqBridgeAgentRunOptions = {}): ActoviqBridgeRunStream {
    return this.client.stream(prompt, {
      ...this.defaults,
      ...options,
      agent: this.agent,
    });
  }

  createSession(
    options: ActoviqBridgeAgentSessionOptions = {},
  ): Promise<ActoviqBridgeSession> {
    return this.client.createSession({
      ...this.defaults,
      ...options,
      agent: this.agent,
    });
  }
}

export class ActoviqBridgeSkillHandle {
  constructor(
    private readonly client: ActoviqBridgeSdkClient,
    readonly skill: string,
    private readonly defaults: ActoviqBridgeSkillRunOptions = {},
  ) {}

  run(args = '', options: ActoviqBridgeSkillRunOptions = {}): Promise<ActoviqBridgeRunResult> {
    return this.client.runSlashCommand(this.skill, args, {
      ...this.defaults,
      ...options,
    });
  }

  stream(args = '', options: ActoviqBridgeSkillRunOptions = {}): ActoviqBridgeRunStream {
    return this.client.streamSlashCommand(this.skill, args, {
      ...this.defaults,
      ...options,
    });
  }

  async runInSession(
    session: ActoviqBridgeSession,
    args = '',
    options: Omit<ActoviqBridgeSkillRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return session.runSlashCommand(this.skill, args, options);
  }

  streamInSession(
    session: ActoviqBridgeSession,
    args = '',
    options: Omit<ActoviqBridgeSkillRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return session.streamSlashCommand(this.skill, args, options);
  }

  metadata(options?: ActoviqBridgeCapabilityLookupOptions): Promise<ActoviqSkillMetadata | undefined> {
    return this.client.getSkillMetadata(this.skill, options);
  }
}

export class ActoviqBridgeAgentsApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  list(options?: Omit<CreateActoviqBridgeSdkOptions, 'cliArgs' | 'cliPath' | 'executable'>) {
    return this.client.listAgents(options);
  }

  use(agent: string, defaults: ActoviqBridgeAgentRunOptions = {}): ActoviqBridgeAgentHandle {
    return new ActoviqBridgeAgentHandle(this.client, agent, defaults);
  }

  run(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.run(prompt, {
      ...options,
      agent,
    });
  }

  stream(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): ActoviqBridgeRunStream {
    return this.client.stream(prompt, {
      ...options,
      agent,
    });
  }

  createSession(
    agent: string,
    options: ActoviqBridgeAgentSessionOptions = {},
  ): Promise<ActoviqBridgeSession> {
    return this.client.createSession({
      ...options,
      agent,
    });
  }
}

export class ActoviqBridgeSkillsApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  list(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSkills(options);
  }

  use(skill: string, defaults: ActoviqBridgeSkillRunOptions = {}): ActoviqBridgeSkillHandle {
    return new ActoviqBridgeSkillHandle(this.client, skill, defaults);
  }

  run(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.runSlashCommand(skill, args, options);
  }

  stream(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): ActoviqBridgeRunStream {
    return this.client.streamSlashCommand(skill, args, options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSkillMetadata(options);
  }

  getMetadata(skill: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getSkillMetadata(skill, options);
  }
}

export class ActoviqBridgeToolsApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  list(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listTools(options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listToolMetadata(options);
  }

  getMetadata(toolName: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getToolMetadata(toolName, options);
  }
}

export class ActoviqBridgeSlashCommandsApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  list(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSlashCommands(options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSlashCommandMetadata(options);
  }

  getMetadata(commandName: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getSlashCommandMetadata(commandName, options);
  }

  run(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.runSlashCommand(commandName, args, options);
  }

  stream(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.streamSlashCommand(commandName, args, options);
  }
}

export class ActoviqBridgeContextApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  usage(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getContextUsage(options);
  }

  compact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.runSlashCommand('compact', args, options);
  }

  streamCompact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return this.client.streamSlashCommand('compact', args, options);
  }

  compactBoundaries(
    sessionId: string,
    options?: Parameters<typeof getActoviqBridgeCompactBoundaries>[1],
  ) {
    return getActoviqBridgeCompactBoundaries(sessionId, options);
  }

  latestCompactBoundary(
    sessionId: string,
    options?: Parameters<typeof getActoviqBridgeLatestCompactBoundary>[1],
  ) {
    return getActoviqBridgeLatestCompactBoundary(sessionId, options);
  }

  compactState(
    sessionId: string,
    options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {},
  ) {
    return this.client.memory.compactState({
      ...options,
      sessionId,
    });
  }
}

export class ActoviqBridgeSessionsApi {
  constructor(private readonly client: ActoviqBridgeSdkClient) {}

  list(options?: Parameters<typeof listActoviqBridgeSessions>[0]) {
    return listActoviqBridgeSessions(options);
  }

  getInfo(sessionId: string, options?: Parameters<typeof getActoviqBridgeSessionInfo>[1]) {
    return getActoviqBridgeSessionInfo(sessionId, options);
  }

  getMessages(sessionId: string, options?: Parameters<typeof getActoviqBridgeSessionMessages>[1]) {
    return getActoviqBridgeSessionMessages(sessionId, options);
  }

  getCompactBoundaries(
    sessionId: string,
    options?: Parameters<typeof getActoviqBridgeCompactBoundaries>[1],
  ) {
    return getActoviqBridgeCompactBoundaries(sessionId, options);
  }

  getLatestCompactBoundary(
    sessionId: string,
    options?: Parameters<typeof getActoviqBridgeLatestCompactBoundary>[1],
  ) {
    return getActoviqBridgeLatestCompactBoundary(sessionId, options);
  }

  getCompactState(
    sessionId: string,
    options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {},
  ) {
    return this.client.memory.compactState({
      ...options,
      sessionId,
    });
  }

  async resume(sessionId: string, options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'> = {}) {
    return this.client.resumeSession(sessionId, options);
  }

  continueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ) {
    return this.client.continueMostRecent(prompt, options);
  }

  streamContinueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ) {
    return this.client.streamContinueMostRecent(prompt, options);
  }

  fork(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ) {
    return this.client.forkSession(sessionId, prompt, options);
  }

  streamFork(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ) {
    return this.client.streamForkSession(sessionId, prompt, options);
  }

  getRuntimeInfo(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getRuntimeInfo(options);
  }

  listAgents(options?: Omit<CreateActoviqBridgeSdkOptions, 'cliArgs' | 'cliPath' | 'executable'>) {
    return this.client.listAgents(options);
  }

  listSkills(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSkills(options);
  }

  listSlashCommands(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSlashCommands(options);
  }

  listTools(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listTools(options);
  }

  getRuntimeCatalog(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getRuntimeCatalog(options);
  }

  listSkillMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSkillMetadata(options);
  }

  listSlashCommandMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSlashCommandMetadata(options);
  }

  listToolMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listToolMetadata(options);
  }

  getContextUsage(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getContextUsage(options);
  }
}

export class ActoviqBridgeSdkClient {
  readonly sessions: ActoviqBridgeSessionsApi;
  readonly agents: ActoviqBridgeAgentsApi;
  readonly skills: ActoviqBridgeSkillsApi;
  readonly tools: ActoviqBridgeToolsApi;
  readonly slashCommands: ActoviqBridgeSlashCommandsApi;
  readonly context: ActoviqBridgeContextApi;
  readonly buddy: ActoviqBuddyApi;
  readonly memory: ActoviqMemoryApi;

  private constructor(
    private readonly executable: string,
    private readonly cliPath: string,
    private readonly defaults: CreateActoviqBridgeSdkOptions,
  ) {
    this.sessions = new ActoviqBridgeSessionsApi(this);
    this.agents = new ActoviqBridgeAgentsApi(this);
    this.skills = new ActoviqBridgeSkillsApi(this);
    this.tools = new ActoviqBridgeToolsApi(this);
    this.slashCommands = new ActoviqBridgeSlashCommandsApi(this);
    this.context = new ActoviqBridgeContextApi(this);
    this.buddy = createActoviqBuddyApi({
      homeDir: this.defaults.homeDir,
    });
    this.memory = createActoviqMemoryApi({
      homeDir: this.defaults.homeDir,
      projectPath: this.defaults.workDir ?? process.cwd(),
    });
  }

  static async create(options: CreateActoviqBridgeSdkOptions = {}): Promise<ActoviqBridgeSdkClient> {
    const executable = await resolveBunExecutable(options.executable);
    const cliPath = await resolveActoviqRuntimeCliPath(options.cliPath);
    return new ActoviqBridgeSdkClient(executable, cliPath, {
      ...options,
      executable: undefined,
      cliPath: undefined,
    });
  }

  async run(prompt: string, options: ActoviqBridgeRunOptions = {}): Promise<ActoviqBridgeRunResult> {
    const stream = this.stream(prompt, options);
    return stream.result;
  }

  runSlashCommand(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.run(formatSlashCommand(commandName, args), options);
  }

  runWithAgent(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.run(prompt, {
      ...options,
      agent,
    });
  }

  runSkill(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.runSlashCommand(skill, args, options);
  }

  continueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.run(prompt, {
      ...options,
      continueMostRecent: true,
    });
  }

  streamContinueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ): ActoviqBridgeRunStream {
    return this.stream(prompt, {
      ...options,
      continueMostRecent: true,
    });
  }

  forkSession(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.run(prompt, {
      ...options,
      resume: sessionId,
      forkSession: true,
    });
  }

  streamForkSession(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ): ActoviqBridgeRunStream {
    return this.stream(prompt, {
      ...options,
      resume: sessionId,
      forkSession: true,
    });
  }

  stream(prompt: string, options: ActoviqBridgeRunOptions = {}): ActoviqBridgeRunStream {
    const mergedOptions = this.mergeOptions(options);
    return new ActoviqBridgeRunStream(async controller => {
      return this.execute(prompt, mergedOptions, controller);
    });
  }

  streamSlashCommand(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    return this.stream(formatSlashCommand(commandName, args), options);
  }

  streamWithAgent(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): ActoviqBridgeRunStream {
    return this.stream(prompt, {
      ...options,
      agent,
    });
  }

  streamSkill(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): ActoviqBridgeRunStream {
    return this.streamSlashCommand(skill, args, options);
  }

  async createSession(options: ActoviqBridgeSessionCreateOptions = {}): Promise<ActoviqBridgeSession> {
    const sessionId = options.sessionId ?? randomUUID();
    return new ActoviqBridgeSession(this, sessionId, options.title, this.mergeOptions(options), false);
  }

  createAgentSession(
    agent: string,
    options: Omit<ActoviqBridgeSessionCreateOptions, 'agent'> = {},
  ): Promise<ActoviqBridgeSession> {
    return this.createSession({
      ...options,
      agent,
    });
  }

  useAgent(agent: string, defaults: ActoviqBridgeAgentRunOptions = {}): ActoviqBridgeAgentHandle {
    return this.agents.use(agent, defaults);
  }

  useSkill(skill: string, defaults: ActoviqBridgeSkillRunOptions = {}): ActoviqBridgeSkillHandle {
    return this.skills.use(skill, defaults);
  }

  async resumeSession(
    sessionId: string,
    options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'> = {},
  ): Promise<ActoviqBridgeSession> {
    return new ActoviqBridgeSession(this, sessionId, options.title, this.mergeOptions(options), true);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  async getRuntimeInfo(
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqRuntimeInfo> {
    const result = await this.run('/cost', {
      ...options,
      includePartialMessages: false,
      maxTurns: options.maxTurns ?? 2,
    });

    if (!result.initEvent) {
      throw new ActoviqBridgeProcessError('Actoviq Runtime did not emit an init event for /cost.');
    }

    return runtimeInfoFromInitEvent(result.initEvent);
  }

  async listSkills(
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<string[]> {
    const info = await this.getRuntimeInfo(options);
    return [...info.skills];
  }

  async listTools(
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<string[]> {
    const info = await this.getRuntimeInfo(options);
    return [...info.tools];
  }

  async listSlashCommands(
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<string[]> {
    const info = await this.getRuntimeInfo(options);
    return [...info.slashCommands];
  }

  async listAgents(
    options: Omit<CreateActoviqBridgeSdkOptions, 'cliArgs' | 'cliPath' | 'executable'> = {},
  ): Promise<ActoviqAgentSummary[]> {
    const raw = await this.runRawCliCommand(['agents'], options);
    return parseActoviqAgentSummaryOutput(raw.stdout);
  }

  async getContextUsage(
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqContextUsage> {
    const result = await this.run('/context', {
      ...options,
      includePartialMessages: false,
      maxTurns: options.maxTurns ?? 2,
    });
    return parseActoviqContextUsageResult(result);
  }

  async getRuntimeCatalog(
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqRuntimeCatalog> {
    const runtimeOptions: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {
      ...options,
    };
    delete (runtimeOptions as { includeContext?: boolean }).includeContext;

    const [runtime, agents, context] = await Promise.all([
      this.getRuntimeInfo(runtimeOptions),
      this.listAgents(runtimeOptions),
      options.includeContext === false
        ? Promise.resolve(undefined)
        : this.getContextUsage(runtimeOptions).catch(() => undefined),
    ]);

    return buildRuntimeCatalog({
      runtime,
      agents,
      context,
    });
  }

  async listSkillMetadata(
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqSkillMetadata[]> {
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.skills;
  }

  async getSkillMetadata(
    skillName: string,
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqSkillMetadata | undefined> {
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.skills.find(skill => skill.name === skillName);
  }

  async listToolMetadata(
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqToolMetadata[]> {
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.tools;
  }

  async getToolMetadata(
    toolName: string,
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqToolMetadata | undefined> {
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.tools.find(tool => tool.name === toolName);
  }

  async listSlashCommandMetadata(
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqSlashCommandMetadata[]> {
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.slashCommands;
  }

  async getSlashCommandMetadata(
    commandName: string,
    options: ActoviqBridgeCapabilityLookupOptions = {},
  ): Promise<ActoviqSlashCommandMetadata | undefined> {
    const normalized = commandName.trim().replace(/^\/+/u, '');
    const catalog = await this.getRuntimeCatalog(options);
    return catalog.slashCommands.find(command => command.name === normalized);
  }

  compactContext(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.runSlashCommand('compact', args, options);
  }

  private mergeOptions<T extends CreateActoviqBridgeSdkOptions>(options: T): T {
    return {
      ...this.defaults,
      ...options,
      executable: this.executable,
      cliPath: this.cliPath,
      workDir: options.workDir ?? this.defaults.workDir ?? process.cwd(),
    };
  }

  private async runRawCliCommand(
    rawArgs: string[],
    options: CreateActoviqBridgeSdkOptions & { signal?: AbortSignal } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime command was aborted before it started.');
    }

    const merged = this.mergeOptions(options);
    const childEnv = buildChildEnvironment(merged.env);
    if (await prefersSystemRipgrep(merged.env)) {
      childEnv.USE_BUILTIN_RIPGREP = '0';
    }

    const child = spawn(merged.executable ?? this.executable, [merged.cliPath ?? this.cliPath, ...rawArgs], {
      cwd: merged.workDir ?? this.defaults.workDir ?? process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell:
        IS_WINDOWS &&
        /\.(?:cmd|bat)$/i.test(merged.executable ?? this.executable),
    });

    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const stdoutPromise = readStdout(child);
    const stderrPromise = readStderr(child);
    const exitCodePromise = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        exitCodePromise,
      ]);

      if (aborted) {
        throw new RunAbortedError('The Actoviq Runtime command was aborted.');
      }
      if (exitCode !== 0) {
        throw new ActoviqBridgeProcessError(
          stderr.trim()
            ? `Actoviq Runtime command failed: ${stderr.trim()}`
            : `Actoviq Runtime command failed with exit code ${exitCode}.`,
          { stderr, exitCode },
        );
      }

      return { stdout, stderr, exitCode };
    } catch (error) {
      const normalized = asError(error);
      if (aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Actoviq Runtime command was aborted.', { cause: error });
      }
      throw new ActoviqBridgeProcessError(normalized.message, { cause: error });
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async execute(
    prompt: string,
    options: ActoviqBridgeRunOptions,
    controller: {
      emit: (event: ActoviqBridgeJsonEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    },
  ): Promise<ActoviqBridgeRunResult> {
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime run was aborted before it started.');
    }

    const childEnv = buildChildEnvironment(options.env);
    if (await prefersSystemRipgrep(options.env)) {
      childEnv.USE_BUILTIN_RIPGREP = '0';
    }

    const args = [options.cliPath ?? this.cliPath, ...buildCliArgs(prompt, options)];
    const child = spawn(options.executable ?? this.executable, args, {
      cwd: options.workDir ?? this.defaults.workDir ?? process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell:
        IS_WINDOWS &&
        /\.(?:cmd|bat)$/i.test(options.executable ?? this.executable),
    });

    const events: ActoviqBridgeJsonEvent[] = [];
    const assistantMessages: ActoviqBridgeJsonEvent[] = [];
    let initEvent: ActoviqBridgeJsonEvent | undefined;
    let resultEvent: ActoviqBridgeJsonEvent | undefined;
    let aborted = false;

    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const stdoutPromise = parseStdoutEvents(child, event => {
      events.push(structuredClone(event));
      if (event.type === 'system' && event.subtype === 'init') {
        initEvent = structuredClone(event);
      }
      if (event.type === 'assistant') {
        assistantMessages.push(structuredClone(event));
      }
      if (event.type === 'result') {
        resultEvent = structuredClone(event);
      }
      controller.emit(event);
    });
    const stderrPromise = readStderr(child);

    const exitCodePromise = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });

    let stderr = '';
    let exitCode: number | null = null;
    try {
      [stderr, exitCode] = await Promise.all([stderrPromise, exitCodePromise, stdoutPromise]).then(
        ([nextStderr, nextExitCode]) => [nextStderr, nextExitCode] as const,
      );
    } catch (error) {
      const normalized = asError(error);
      if (aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Actoviq Runtime run was aborted.', { cause: error });
      }
      throw new ActoviqBridgeProcessError(normalized.message, { cause: error, stderr, exitCode });
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }

    if (aborted && !resultEvent) {
      throw new RunAbortedError('The Actoviq Runtime run was aborted.');
    }

    if (!resultEvent) {
      throw new ActoviqBridgeProcessError(
        stderr.trim()
          ? `Actoviq Runtime exited without a result event: ${stderr.trim()}`
          : 'Actoviq Runtime exited without emitting a result event.',
        { stderr, exitCode },
      );
    }

    const result: ActoviqBridgeRunResult = {
      text: deriveResultText(resultEvent, assistantMessages),
      sessionId:
        getStringValue(resultEvent, 'session_id') ??
        getStringValue(initEvent, 'session_id') ??
        options.sessionId ??
        (typeof options.resume === 'string' ? options.resume : ''),
      isError: getBooleanValue(resultEvent, 'is_error') ?? false,
      subtype: getStringValue(resultEvent, 'subtype'),
      stopReason: getStringValue(resultEvent, 'stop_reason'),
      durationMs: getNumberValue(resultEvent, 'duration_ms'),
      totalCostUsd: getNumberValue(resultEvent, 'total_cost_usd'),
      numTurns: getNumberValue(resultEvent, 'num_turns'),
      exitCode,
      stderr,
      initEvent,
      resultEvent,
      assistantMessages,
      events,
    };

    return result;
  }
}

export async function createActoviqBridgeSdk(
  options: CreateActoviqBridgeSdkOptions = {},
): Promise<ActoviqBridgeSdkClient> {
  return ActoviqBridgeSdkClient.create(options);
}
