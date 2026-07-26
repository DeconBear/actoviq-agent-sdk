import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createActoviqBuddyApi, type ActoviqBuddyApi } from '../buddy/actoviqBuddy.js';
import {
  findExecutableOnPath,
  findFirstExistingPath,
  isExecutable,
  IS_WINDOWS,
  pathExists,
  resolveExecutableInvocation,
} from './bridgeExecResolver.js';
import type {
  BridgeEventNormalizer,
  BridgeProcessControl,
  RuntimeProvider,
} from './bridgeProviders.js';
import { resolveProvider } from './bridgeProviders.js';
import { terminateManagedProcessTree as terminateActoviqProcessTree } from './bridgeProcessTree.js';
import { runCrushManaged } from './crushManagedClient.js';
import {
  namedExternalCliManagedProfileId,
  resolveCodewhaleNativeSessionId,
} from './externalCliSessions.js';
import {
  createReasonixManagedClient,
  type ReasonixManagedClient,
} from './reasonixManagedClient.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import { resolveActoviqHome } from '../config/actoviqHome.js';
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
const MAX_CAPTURED_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURED_STDERR_BYTES = 1024 * 1024;
const MAX_RETAINED_RUN_EVENTS = 1_000;
const MAX_RETAINED_ASSISTANT_MESSAGES = 128;
const OUTPUT_TRUNCATION_MARKER = '[Actoviq output truncated]\n';

class BoundedRetention<T> {
  private readonly values: T[] = [];
  private nextWriteIndex = 0;

  constructor(private readonly capacity: number) {}

  push(value: T): void {
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    this.values[this.nextWriteIndex] = value;
    this.nextWriteIndex = (this.nextWriteIndex + 1) % this.capacity;
  }

  toArray(): T[] {
    if (this.values.length < this.capacity || this.nextWriteIndex === 0) {
      return [...this.values];
    }
    return [
      ...this.values.slice(this.nextWriteIndex),
      ...this.values.slice(0, this.nextWriteIndex),
    ];
  }
}

function isAbortErrorLike(error: unknown): boolean {
  return error instanceof RunAbortedError || (error instanceof Error && error.name === 'AbortError');
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

/**
 * Resolve the executable for direct-CLI mode. Provider-specific PATH lookup
 * and error messaging now live in each RuntimeProvider (bridgeProviders.ts);
 * this file only needs the bundle-path resolver above.
 */

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

function getNonEmptyStringValue(
  event: ActoviqBridgeJsonEvent | undefined,
  key: string,
): string | undefined {
  const value = getStringValue(event, key)?.trim();
  return value || undefined;
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
    options.permissionMode === 'bypassPermissions';
  if (shouldSkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  appendOptionalArg(args, '--permission-mode', options.permissionMode ?? 'default');
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
    args.push(`--resume=${options.resume}`);
  } else if (options.resume === true) {
    args.push('--resume');
  } else if (options.sessionId) {
    args.push(`--session-id=${options.sessionId}`);
  }

  if (options.cliArgs?.length) {
    args.push(...options.cliArgs);
  }

  // Claude's `-p` is a boolean flag; the prompt is positional. Keep arbitrary
  // prompt text behind the option terminator so it cannot be reinterpreted as
  // a permission or configuration flag.
  args.push('--', prompt);

  return args;
}

interface PreparedChildEnvironment {
  env: Record<string, string>;
  secrets: string[];
  cleanup?: () => Promise<void>;
}

interface ManagedReasonixEntry {
  client: ReasonixManagedClient;
  transcriptPath: string;
  transcriptCreatedAt: string;
  transcriptTitle?: string;
  cleanup?: () => Promise<void>;
  cleanupPromise?: Promise<void>;
}

async function writeReasonixTranscriptMetadata(
  entry: ManagedReasonixEntry,
  options: {
    sessionId: string;
    cwd: string;
    model?: string;
    prompt: string;
  },
): Promise<void> {
  entry.transcriptTitle ??= options.prompt.replace(/\s+/gu, ' ').trim().slice(0, 160);
  const extension = path.extname(entry.transcriptPath);
  const stem = extension
    ? entry.transcriptPath.slice(0, -extension.length)
    : entry.transcriptPath;
  await writeFile(`${stem}.acp.json`, `${JSON.stringify({
    sessionId: options.sessionId,
    title: entry.transcriptTitle || options.sessionId,
    cwd: options.cwd,
    model: options.model,
    createdAt: entry.transcriptCreatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function reasonixConfigFingerprint(options: ActoviqBridgeRunOptions): string {
  const env = Object.entries(options.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify({
    authSource: options.authSource ?? 'native',
    apiKey: options.apiKey ?? '',
    baseURL: options.baseURL ?? '',
    credentialProvider: options.credentialProvider ?? '',
    homeDir: options.homeDir ?? '',
    model: options.model ?? '',
    profileName: options.profileName ?? '',
    env,
  })).digest('hex');
}

function reasonixManagedAliasKey(
  configFingerprint: string,
  cwd: string,
  sessionId: string,
): string {
  return `${configFingerprint}\0${cwd}\0${sessionId}`;
}

function validateReasonixManagedSessionId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 512
    || normalized.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ActoviqBridgeProcessError(
      'Reasonix session id must be a non-option value without control characters.',
    );
  }
  return normalized;
}

const COMMON_UNSUPPORTED_MANAGED_OPTIONS = [
  'fallbackModel',
  'systemPrompt',
  'appendSystemPrompt',
  'maxTurns',
  'agent',
  'agents',
  'tools',
  'allowedTools',
  'disallowedTools',
  'addDirs',
  'mcpConfigs',
  'strictMcpConfig',
  'settings',
  'settingSources',
  'jsonSchema',
  'files',
  'bare',
  'disableSlashCommands',
  'includeHookEvents',
  'pluginDirs',
  'cliArgs',
] as const satisfies readonly (keyof ActoviqBridgeRunOptions)[];

function managedOptionWasRequested(
  options: ActoviqBridgeRunOptions,
  key: keyof ActoviqBridgeRunOptions,
): boolean {
  const value = options[key];
  if (value == null) return false;
  // `tools: []` and `tools: 'none'` both explicitly disable the native tool
  // set, so they remain meaningful even though the collection is empty.
  if (key === 'tools') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return value;
  return true;
}

function assertManagedOptionsSupported(
  runtime: 'Reasonix' | 'Crush',
  options: ActoviqBridgeRunOptions,
  extraUnsupported: readonly (keyof ActoviqBridgeRunOptions)[] = [],
): void {
  const unsupported = [...COMMON_UNSUPPORTED_MANAGED_OPTIONS, ...extraUnsupported]
    .filter(key => managedOptionWasRequested(options, key));
  if (unsupported.length === 0) return;
  throw new ActoviqBridgeProcessError(
    `${runtime} managed mode cannot enforce bridge option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
  );
}

const BRIDGE_AUTH_ENV_KEYS = new Set([
  'ACTOVIQ_API_KEY',
  'ACTOVIQ_AUTH_TOKEN',
  'ACTOVIQ_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'AZURE_OPENAI_API_KEY',
]);
const ACTOVIQ_AUTH_ENV_KEYS = new Set([
  'ACTOVIQ_API_KEY',
  'ACTOVIQ_AUTH_TOKEN',
  'ACTOVIQ_BASE_URL',
]);
const API_KEY_CHILD_ENV_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'CI',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LOCALAPPDATA',
  'NODE_ENV',
  'NO_COLOR',
  'NO_PROXY',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // Paths needed by common compiler/toolchain subprocesses. Authentication
  // helpers (AWS/GH/SSH/etc.) are deliberately excluded.
  'BUN_INSTALL',
  'CARGO_HOME',
  'CONDA_PREFIX',
  'DOTNET_ROOT',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
  'NVM_HOME',
  'NVM_SYMLINK',
  'PNPM_HOME',
  'PYENV_ROOT',
  'RUSTUP_HOME',
  'VIRTUAL_ENV',
]);
const SENSITIVE_ENV_KEY = /(?:^|_)(?:API_?KEY|AUTH|COOKIE|CREDENTIALS?|KEY|PASS(?:WORD|WD)?|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/iu;

async function findCrushProjectConfig(workDir: string): Promise<string | undefined> {
  let directory = path.resolve(workDir);
  while (true) {
    for (const name of ['crush.json', '.crush.json']) {
      const candidate = path.join(directory, name);
      if (await pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const PROVIDER_DEFAULT_API_KEY_ENV: Record<string, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codewhale: ['DEEPSEEK_API_KEY'],
  pi: ['OPENAI_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  crush: ['CRUSH_OPENAI_API_KEY'],
  reasonix: ['DEEPSEEK_API_KEY'],
};

const CREDENTIAL_PROVIDER_ENV: Record<string, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
};

const PROVIDER_NATIVE_AUTH_ENV: Record<string, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
  codewhale: ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  pi: ['OPENAI_API_KEY'],
  codex: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY'],
  crush: ['CRUSH_OPENAI_API_KEY'],
  reasonix: ['DEEPSEEK_API_KEY'],
};

const PROVIDER_BASE_URL_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_BASE_URL',
  codewhale: 'DEEPSEEK_BASE_URL',
  pi: 'OPENAI_BASE_URL',
  codex: 'OPENAI_BASE_URL',
  crush: 'CRUSH_OPENAI_BASE_URL',
  reasonix: 'DEEPSEEK_BASE_URL',
};

function withoutActoviqAuth(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !ACTOVIQ_AUTH_ENV_KEYS.has(key.toUpperCase())),
  );
}

function withoutProviderAuth(
  provider: RuntimeProvider,
  values: Record<string, string>,
): Record<string, string> {
  const denied = new Set([
    ...BRIDGE_AUTH_ENV_KEYS,
    ...(PROVIDER_NATIVE_AUTH_ENV[provider.id] ?? []),
  ].map(key => key.toUpperCase()));
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => {
      const normalized = key.toUpperCase();
      return !denied.has(normalized)
        && !SENSITIVE_ENV_KEY.test(normalized)
        && normalized !== 'SSH_AUTH_SOCK'
        && !/^(?:AWS|AZURE|GCP|GOOGLE|GH|GITHUB|GITLAB|NPM)_/u.test(normalized)
        && !(provider.id === 'crush' && normalized.startsWith('CRUSH_'));
    }),
  );
}

function safeProxyEnvironmentValue(key: string, value: string): boolean {
  if (!/(?:^|_)PROXY$/iu.test(key) || key.toUpperCase() === 'NO_PROXY') return true;
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  } catch {
    return key.toUpperCase() === 'NO_PROXY';
  }
}

function apiKeyChildBaseEnvironment(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => {
      const normalized = key.toUpperCase();
      return (
        API_KEY_CHILD_ENV_KEYS.has(normalized)
        || normalized.startsWith('LC_')
        || normalized === 'ACTOVIQ_E2E_INVOCATIONS'
      ) && safeProxyEnvironmentValue(normalized, value);
    }),
  );
}

function environmentValue(
  values: Record<string, string>,
  keys: readonly string[],
): string | undefined {
  const wanted = new Set(keys.map(key => key.toUpperCase()));
  return Object.entries(values).find(([key, value]) =>
    wanted.has(key.toUpperCase()) && Boolean(value.trim()))?.[1];
}

function credentialProviderHint(options: CreateActoviqBridgeSdkOptions): string | undefined {
  const explicit = options.credentialProvider?.trim().toLowerCase();
  if (explicit) return explicit;
  const model = options.model?.trim();
  const separator = model?.indexOf('/') ?? -1;
  if (model && separator > 0) return model.slice(0, separator).toLowerCase();
  const baseURL = options.baseURL?.toLowerCase() ?? '';
  return Object.keys(CREDENTIAL_PROVIDER_ENV).find(name => baseURL.includes(name));
}

function providerCredentialKeys(
  provider: RuntimeProvider,
  options: CreateActoviqBridgeSdkOptions,
): readonly string[] {
  const hint = credentialProviderHint(options);
  const keys = (hint && CREDENTIAL_PROVIDER_ENV[hint])
    || PROVIDER_DEFAULT_API_KEY_ENV[provider.id]
    || [];
  return provider.id === 'crush'
    ? keys.map(key => key.startsWith('CRUSH_') ? key : `CRUSH_${key}`)
    : keys;
}

function crushManagedModel(
  options: CreateActoviqBridgeSdkOptions,
  credentialProvider: string | undefined,
): string | undefined {
  const model = options.model?.trim();
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || !credentialProvider) return model;
  return model.slice(0, separator).toLowerCase() === credentialProvider
    ? model.slice(separator + 1)
    : model;
}

function providerApiKeyEnvironment(
  provider: RuntimeProvider,
  options: CreateActoviqBridgeSdkOptions,
  apiKey: string | undefined,
  baseURL: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  const normalizedKey = apiKey?.trim();
  if (normalizedKey) {
    for (const key of providerCredentialKeys(provider, options)) env[key] = normalizedKey;
  }
  const normalizedBaseURL = baseURL?.trim();
  const credentialKey = providerCredentialKeys(provider, options)[0];
  const baseURLKey = credentialKey?.replace(/_API_KEY$/u, '_BASE_URL')
    ?? PROVIDER_BASE_URL_ENV[provider.id];
  if (normalizedBaseURL && baseURLKey) env[baseURLKey] = normalizedBaseURL;
  return env;
}

function credentialValues(values: Record<string, string>): string[] {
  return [...new Set(
    Object.entries(values)
      .filter(([key, value]) =>
        value
        && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|COOKIE)$/iu.test(key))
      .map(([, value]) => value),
  )];
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) await chmod(directory, 0o700);
}

async function persistentExternalCliProfile(
  provider: RuntimeProvider,
  options: CreateActoviqBridgeSdkOptions,
): Promise<string> {
  const namedIdentity = options.profileName?.trim();
  const identity = namedIdentity
    ? `name:${namedIdentity}`
    : `anonymous:${credentialProviderHint(options) ?? ''}\0${options.baseURL ?? ''}`;
  const profileId = namedIdentity
    ? namedExternalCliManagedProfileId(provider.id, namedIdentity)
    : createHash('sha256').update(`${provider.id}\0${identity}`).digest('hex');
  const root = path.join(
    resolveActoviqHome(options.homeDir),
    'external-cli-profiles',
    provider.id,
    profileId,
  );
  await ensurePrivateDirectory(root);
  return root;
}

async function buildChildEnvironment(
  provider: RuntimeProvider,
  options: CreateActoviqBridgeSdkOptions,
  directCli: boolean,
): Promise<PreparedChildEnvironment> {
  const loadedConfig = getLoadedJsonConfig();
  const settingsEnv = loadedConfig?.env ?? {};
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const envOverrides = options.env ?? {};
  const authSource = options.authSource ?? (directCli ? 'native' : undefined);

  // Native mode deliberately bypasses provider.buildChildEnv: Claude's legacy
  // builder maps ACTOVIQ_* into ANTHROPIC_*, which would override the CLI's
  // OAuth/keychain login. Inherited process env remains untouched because it is
  // part of the environment in which the user normally launches the CLI.
  if (authSource === 'native') {
    const env = {
      ...withoutActoviqAuth(baseEnv),
      ...withoutActoviqAuth(envOverrides),
    };
    return {
      env,
      secrets: credentialValues(env),
    };
  }

  if (authSource === 'apiKey') {
    const legacyOverrideKeys = provider.id === 'codex' ? ['OPENAI_API_KEY'] : [];
    const requestedApiKey = options.apiKey
      ?? environmentValue(envOverrides, [
        ...providerCredentialKeys(provider, options),
        ...legacyOverrideKeys,
      ]);
    const baseURLKey = PROVIDER_BASE_URL_ENV[provider.id];
    const requestedBaseURL = options.baseURL
      ?? (baseURLKey ? environmentValue(envOverrides, [baseURLKey]) : undefined);
    const authEnv = providerApiKeyEnvironment(
      provider,
      options,
      requestedApiKey,
      requestedBaseURL,
    );
    if (credentialValues(authEnv).length === 0) {
      throw new ActoviqBridgeProcessError(
        'authSource "apiKey" requires apiKey or a provider credential in env.',
      );
    }
    const env = {
      ...withoutProviderAuth(provider, apiKeyChildBaseEnvironment(baseEnv)),
      // Direct CLI mode never imports ~/.actoviq/settings.json env wholesale.
      // It may contain unrelated GitHub/AWS/database secrets. Explicit per-run
      // overrides remain supported, minus competing runtime credentials.
      ...withoutProviderAuth(provider, envOverrides),
      ...authEnv,
    };
    if (
      directCli
      && (
        provider.id === 'pi'
        || provider.id === 'codewhale'
        || provider.id === 'reasonix'
        || provider.id === 'crush'
      )
    ) {
      // These CLIs prefer their native credential store over environment keys.
      // An empty per-run config home makes the explicit child-only key win
      // without reading or modifying the user's login files.
      const isolatedHome = await mkdtemp(path.join(os.tmpdir(), `actoviq-${provider.id}-auth-`));
      if (provider.id === 'pi') {
        env.PI_CODING_AGENT_DIR = isolatedHome;
        env.PI_CODING_AGENT_SESSION_DIR = path.join(
          await persistentExternalCliProfile(provider, options),
          'sessions',
        );
        await ensurePrivateDirectory(env.PI_CODING_AGENT_SESSION_DIR);
      }
      if (provider.id === 'codewhale') {
        env.CODEWHALE_HOME = await persistentExternalCliProfile(
          provider,
          options,
        );
        env.CODEWHALE_CONFIG_PATH = path.join(isolatedHome, 'config.json');
      }
      if (provider.id === 'reasonix') {
        const profileHome = await persistentExternalCliProfile(
          provider,
          options,
        );
        // Reasonix 0.53 ignores REASONIX_HOME and resolves ~/.reasonix through
        // os.homedir(). Override both home variables so explicit-key mode does
        // not read or mutate the user's native config, memory, or skills.
        env.HOME = profileHome;
        env.USERPROFILE = profileHome;
        env.REASONIX_HOME = path.join(profileHome, '.reasonix');
        await ensurePrivateDirectory(env.REASONIX_HOME);
      }
      if (provider.id === 'crush') {
        const profile = await persistentExternalCliProfile(provider, options);
        env.CRUSH_GLOBAL_CONFIG = path.join(isolatedHome, 'config');
        env.CRUSH_GLOBAL_DATA = path.join(profile, 'data');
        env.CRUSH_CACHE_DIR = path.join(isolatedHome, 'cache');
        env.XDG_CONFIG_HOME = path.join(isolatedHome, 'xdg-config');
        await ensurePrivateDirectory(env.CRUSH_GLOBAL_DATA);
      }
      return {
        env,
        secrets: credentialValues(env),
        cleanup: () => rm(isolatedHome, { recursive: true, force: true }),
      };
    }
    return { env, secrets: credentialValues(env) };
  }

  // The vendored bridge keeps its historical Actoviq settings mapping when no
  // auth source is selected. This preserves the existing non-direct API.
  return {
    env: provider.buildChildEnv(baseEnv, settingsEnv, envOverrides),
    secrets: [],
  };
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function redactEventValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactEventValue(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactEventValue(item, secrets)]),
  );
}

function redactEvent(
  event: ActoviqBridgeJsonEvent,
  secrets: readonly string[],
): ActoviqBridgeJsonEvent {
  if (secrets.length === 0) return event;
  return redactEventValue(event, secrets) as ActoviqBridgeJsonEvent;
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
  normalizer: BridgeEventNormalizer,
  control?: BridgeProcessControl,
  secrets: readonly string[] = [],
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

    if (normalizer.rawText) {
      // Plain-text provider — feed each line as-is; no JSON structure.
      for (const event of normalizer.translate({ _raw: trimmed }, control)) {
        onEvent(redactEvent(event, secrets));
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ActoviqBridgeProcessError(`Failed to parse Actoviq Runtime stream line: ${redactText(trimmed, secrets)}`, {
        cause: error,
      });
    }

    if (!isRecord(parsed) || (!normalizer.interactive && typeof parsed.type !== 'string')) {
      throw new ActoviqBridgeProcessError('Actoviq Runtime emitted a malformed stream event.');
    }

    // Providers whose native wire format differs from the canonical
    // system/assistant/result trio (pi, codex) translate here; claude is a
    // passthrough normalizer, so its behavior is unchanged.
    for (const event of normalizer.translate(parsed, control)) {
      onEvent(redactEvent(event, secrets));
    }
  }

  // Raw-text providers flush accumulated text at stream end.
  if (normalizer.flush) {
    for (const event of normalizer.flush()) {
      onEvent(redactEvent(event, secrets));
    }
  }
}

async function readBoundedText(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return '';

  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER);
  const payloadLimit = Math.max(0, maxBytes - markerBytes);
  let retained: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  for await (const chunk of stream) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const combined = retained.length === 0 ? next : Buffer.concat([retained, next]);
    if (combined.length > payloadLimit) {
      retained = Buffer.from(combined.subarray(combined.length - payloadLimit));
      truncated = true;
    } else {
      retained = combined;
    }
  }
  return `${truncated ? OUTPUT_TRUNCATION_MARKER : ''}${retained.toString('utf8')}`;
}

function readStderr(child: ReturnType<typeof spawn>): Promise<string> {
  return readBoundedText(child.stderr, MAX_CAPTURED_STDERR_BYTES);
}

function readStdout(child: ReturnType<typeof spawn>): Promise<string> {
  return readBoundedText(child.stdout, MAX_CAPTURED_STDOUT_BYTES);
}

export class ActoviqBridgeRunStream implements AsyncIterable<ActoviqBridgeJsonEvent> {
  private readonly queue = new AsyncQueue<ActoviqBridgeJsonEvent>({
    capacity: MAX_RETAINED_RUN_EVENTS,
    overflowStrategy: 'drop-oldest',
    isPriority: event => event.type === 'system' || event.type === 'result',
    priorityReserve: 2,
    canDrop: event => event.type !== 'system' && event.type !== 'result',
  });
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
  private runAttempt = 0;
  private runtimeSessionId: string;

  constructor(
    private readonly client: ActoviqBridgeSdkClient,
    id: string,
    readonly title: string | undefined,
    private readonly defaults: ActoviqBridgeSessionCreateOptions,
    started = false,
  ) {
    this.runtimeSessionId = id;
    this.started = started;
  }

  get id(): string {
    return this.runtimeSessionId;
  }

  async send(prompt: string, options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<ActoviqBridgeRunResult> {
    const runOptions = this.buildRunOptions(options);
    this.runAttempt += 1;
    const result = await this.client.run(prompt, runOptions);
    this.adoptRuntimeSessionId(result);
    this.started = true;
    return result;
  }

  stream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqBridgeRunStream {
    const wasStarted = this.started;
    const runOptions = this.buildRunOptions(options);
    const attempt = this.runAttempt + 1;
    const runStream = this.client.stream(prompt, runOptions);
    this.runAttempt = attempt;
    this.started = true;
    void runStream.result.then(
      result => this.adoptRuntimeSessionId(result),
      () => {
        if (!wasStarted && this.runAttempt === attempt) this.started = false;
      },
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

  private adoptRuntimeSessionId(result: ActoviqBridgeRunResult): void {
    const sessionId = result.sessionId.trim();
    if (sessionId) this.runtimeSessionId = sessionId;
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
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();
  private readonly reasonixManagedEntries = new Map<string, ManagedReasonixEntry>();
  private readonly reasonixManagedEntryPromises = new Map<
    string,
    Promise<ManagedReasonixEntry>
  >();
  private closed = false;

  private constructor(
    private readonly executable: string,
    private readonly cliPath: string,
    private readonly directCli: boolean,
    private readonly provider: RuntimeProvider,
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
    if (options.directCli) {
      const provider = resolveProvider(options.directCliProvider);
      const executable = await provider.resolveExecutable(options.executable);
      // cliPath is retained so a node+script pair works too, but left empty for
      // a plain binary executable (real `claude` on PATH).
      const cliPath = options.cliPath ?? '';
      return new ActoviqBridgeSdkClient(executable, cliPath, true, provider, {
        ...options,
        executable: undefined,
        cliPath: undefined,
      });
    }
    const executable = await resolveBunExecutable(options.executable);
    const cliPath = await resolveActoviqRuntimeCliPath(options.cliPath);
    return new ActoviqBridgeSdkClient(executable, cliPath, false, resolveProvider('claude'), {
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
    if (
      this.closed
      && this.activeChildren.size === 0
      && this.reasonixManagedEntries.size === 0
      && this.reasonixManagedEntryPromises.size === 0
    ) return;
    this.closed = true;
    const pendingEntries = await Promise.allSettled([
      ...this.reasonixManagedEntryPromises.values(),
    ]);
    const reasonixEntries = new Set(this.reasonixManagedEntries.values());
    for (const pending of pendingEntries) {
      if (pending.status === 'fulfilled') reasonixEntries.add(pending.value);
    }
    await Promise.all([...reasonixEntries].map(entry => this.releaseReasonixEntry(entry)));
    const children = [...this.activeChildren];
    await Promise.all(children.map(child => terminateActoviqProcessTree(child)));
    for (const child of children) this.activeChildren.delete(child);
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
    if (this.closed) {
      throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
    }
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime command was aborted before it started.');
    }

    const merged = this.mergeOptions(options);
    if (this.closed) throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime command was aborted before it started.');
    }
    const childEnvironment = await buildChildEnvironment(this.provider, merged, this.directCli);
    if (await prefersSystemRipgrep(merged.env)) {
      childEnvironment.env.USE_BUILTIN_RIPGREP = '0';
    }

    const spawnArgs = this.directCli
      ? (this.cliPath ? [this.cliPath, ...rawArgs] : rawArgs)
      : [merged.cliPath ?? this.cliPath, ...rawArgs];
    const invocation = await resolveExecutableInvocation(
      merged.executable ?? this.executable,
      spawnArgs,
    );
    if (this.closed) throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime command was aborted before it started.');
    }
    const child = spawn(invocation.file, invocation.args, {
      cwd: merged.workDir ?? this.defaults.workDir ?? process.cwd(),
      env: childEnvironment.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: !IS_WINDOWS,
    });
    this.activeChildren.add(child);
    child.once('close', () => this.activeChildren.delete(child));

    let aborted = false;
    let terminationPromise: Promise<void> | undefined;
    const abort = () => {
      aborted = true;
      terminationPromise ??= terminateActoviqProcessTree(child);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    const stdoutPromise = readStdout(child).then(value => redactText(value, childEnvironment.secrets));
    const stderrPromise = readStderr(child).then(value => redactText(value, childEnvironment.secrets));
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
      terminationPromise ??= terminateActoviqProcessTree(child);
      const normalized = asError(error);
      if (aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Actoviq Runtime command was aborted.', { cause: error });
      }
      throw new ActoviqBridgeProcessError(
        redactText(normalized.message, childEnvironment.secrets),
        { cause: error },
      );
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (terminationPromise) await terminationPromise;
      this.activeChildren.delete(child);
      await childEnvironment.cleanup?.();
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
    if (this.closed) {
      throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
    }
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime run was aborted before it started.');
    }

    if (this.directCli && this.provider.id === 'reasonix') {
      return this.executeManagedReasonix(prompt, options, controller);
    }

    if (this.directCli && this.provider.id === 'crush') {
      return this.executeManagedCrush(prompt, options, controller);
    }

    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime run was aborted before it started.');
    }

    // argv: claude (bundle or directCli) reuses the full stream-json flag set
    // in buildCliArgs(); pi/codex use their provider-specific buildArgs().
    const cliArgs = this.provider.id === 'claude'
      ? buildCliArgs(prompt, options)
      : this.provider.buildArgs(prompt, options);
    const args = this.directCli
      ? (this.cliPath ? [this.cliPath, ...cliArgs] : cliArgs)
      : [options.cliPath ?? this.cliPath, ...cliArgs];
    const invocation = await resolveExecutableInvocation(
      options.executable ?? this.executable,
      args,
    );
    if (this.closed) throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
    if (options.signal?.aborted) {
      throw new RunAbortedError('The Actoviq Runtime run was aborted before it started.');
    }
    const childEnvironment = await buildChildEnvironment(this.provider, options, this.directCli);
    if (await prefersSystemRipgrep(options.env)) {
      childEnvironment.env.USE_BUILTIN_RIPGREP = '0';
    }
    const normalizer = this.provider.createNormalizer(prompt, options);
    const effectiveWorkDir = path.resolve(
      options.workDir ?? this.defaults.workDir ?? process.cwd(),
    );
    const runStartedAtMs = Date.now();
    const child = spawn(invocation.file, invocation.args, {
      cwd: effectiveWorkDir,
      env: childEnvironment.env,
      stdio: [normalizer.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: !IS_WINDOWS,
    });
    this.activeChildren.add(child);
    child.once('close', () => this.activeChildren.delete(child));

    let inputEnded = false;
    child.stdin?.on('error', () => {
      // The child may close stdin after its terminal protocol response. The
      // process exit/result path below remains the source of truth.
    });
    const processControl: BridgeProcessControl = {
      write: record => {
        if (inputEnded || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(record)}\n`);
      },
      endInput: () => {
        if (inputEnded) return;
        inputEnded = true;
        child.stdin?.end();
      },
    };

    const retainedEvents = new BoundedRetention<ActoviqBridgeJsonEvent>(MAX_RETAINED_RUN_EVENTS);
    const retainedAssistantMessages = new BoundedRetention<ActoviqBridgeJsonEvent>(
      MAX_RETAINED_ASSISTANT_MESSAGES,
    );
    let initEvent: ActoviqBridgeJsonEvent | undefined;
    let resultEvent: ActoviqBridgeJsonEvent | undefined;
    let codewhaleNativeSessionId: string | undefined;
    let aborted = false;
    let terminationPromise: Promise<void> | undefined;

    const abort = () => {
      aborted = true;
      if (normalizer.abort) {
        normalizer.abort(processControl);
        terminationPromise ??= (async () => {
          await new Promise(resolve => setTimeout(resolve, normalizer.abortGraceMs ?? 250));
          await terminateActoviqProcessTree(child);
        })();
      } else {
        terminationPromise ??= terminateActoviqProcessTree(child);
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    normalizer.start?.(processControl);
    const stdoutPromise = parseStdoutEvents(child, event => {
      retainedEvents.push(structuredClone(event));
      if (event.type === 'system' && event.subtype === 'init') {
        initEvent = structuredClone(event);
      }
      if (event.type === 'assistant') {
        retainedAssistantMessages.push(structuredClone(event));
      }
      if (event.type === 'result') {
        resultEvent = structuredClone(event);
      }
      controller.emit(event);
    }, normalizer, processControl, childEnvironment.secrets);
    const stderrPromise = readStderr(child).then(value => redactText(value, childEnvironment.secrets));

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
      if (this.provider.id === 'codewhale' && resultEvent) {
        const correlationHint = getStringValue(resultEvent, 'correlationHint')
          ?? getStringValue(initEvent, 'correlationHint');
        if (correlationHint) {
          const codewhaleHome = environmentValue(
            childEnvironment.env,
            ['CODEWHALE_HOME'],
          );
          codewhaleNativeSessionId = await resolveCodewhaleNativeSessionId({
            correlationHint,
            cwd: getStringValue(initEvent, 'cwd') ?? effectiveWorkDir,
            startedAtMs: runStartedAtMs,
            finishedAtMs: Date.now(),
            homeDir: options.homeDir
              ?? environmentValue(childEnvironment.env, ['HOME', 'USERPROFILE']),
            codewhaleRoot: codewhaleHome
              ? path.join(path.resolve(effectiveWorkDir, codewhaleHome), 'sessions')
              : undefined,
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      // A parser/normalizer/pipe failure can reject before the CLI exits. Keep
      // the child supervised until its entire process tree has been reclaimed;
      // otherwise close() would lose it when the record is removed below.
      terminationPromise ??= terminateActoviqProcessTree(child);
      const normalized = asError(error);
      if (aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Actoviq Runtime run was aborted.', { cause: error });
      }
      throw new ActoviqBridgeProcessError(
        redactText(normalized.message, childEnvironment.secrets),
        { cause: error, stderr, exitCode },
      );
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (terminationPromise) await terminationPromise;
      this.activeChildren.delete(child);
      await childEnvironment.cleanup?.();
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

    const assistantMessages = retainedAssistantMessages.toArray();
    const events = retainedEvents.toArray();

    const result: ActoviqBridgeRunResult = {
      text: deriveResultText(resultEvent, assistantMessages),
      sessionId:
        getNonEmptyStringValue(resultEvent, 'session_id') ??
        getNonEmptyStringValue(initEvent, 'session_id') ??
        codewhaleNativeSessionId ??
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

  private async executeManagedReasonix(
    prompt: string,
    options: ActoviqBridgeRunOptions,
    controller: {
      emit: (event: ActoviqBridgeJsonEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    },
  ): Promise<ActoviqBridgeRunResult> {
    assertManagedOptionsSupported('Reasonix', options);
    if (options.forkSession) {
      throw new ActoviqBridgeProcessError(
        'Reasonix managed mode does not expose a native session-fork operation.',
      );
    }
    if (options.resume === true || options.continueMostRecent) {
      throw new ActoviqBridgeProcessError(
        'Reasonix managed mode requires an exact persisted session id.',
      );
    }

    const nativeSessionId = typeof options.resume === 'string'
      ? validateReasonixManagedSessionId(options.resume)
      : undefined;
    const cwd = path.resolve(options.workDir ?? this.defaults.workDir ?? process.cwd());
    const configFingerprint = reasonixConfigFingerprint(options);
    const logicalSessionId = (
      nativeSessionId ?? options.sessionId?.trim()
    ) || '__default__';
    const aliasKey = reasonixManagedAliasKey(configFingerprint, cwd, logicalSessionId);
    const entry = await this.getOrCreateReasonixEntry(
      aliasKey,
      configFingerprint,
      cwd,
      nativeSessionId,
      options,
    );
    const retainedEvents = new BoundedRetention<ActoviqBridgeJsonEvent>(MAX_RETAINED_RUN_EVENTS);
    const retainedAssistantMessages = new BoundedRetention<ActoviqBridgeJsonEvent>(
      MAX_RETAINED_ASSISTANT_MESSAGES,
    );
    let initEvent: ActoviqBridgeJsonEvent | undefined;
    let resultEvent: ActoviqBridgeJsonEvent | undefined;
    const onEvent = (event: ActoviqBridgeJsonEvent): void => {
      retainedEvents.push(structuredClone(event));
      if (event.type === 'system' && event.subtype === 'init') {
        initEvent = structuredClone(event);
      }
      if (event.type === 'assistant') {
        retainedAssistantMessages.push(structuredClone(event));
      }
      if (event.type === 'result') {
        resultEvent = structuredClone(event);
      }
      controller.emit(event);
    };

    try {
      const managed = await entry.client.run({
        prompt,
        model: options.model,
        effort: options.effort,
        maxBudgetUsd: options.maxBudgetUsd,
        permissionMode: options.dangerouslySkipPermissions
          ? 'bypassPermissions'
          : options.permissionMode ?? 'default',
        signal: options.signal,
        onEvent,
      });
      if (!resultEvent) {
        await this.releaseReasonixEntry(entry);
        throw new ActoviqBridgeProcessError(
          managed.stderr.trim()
            ? `Reasonix exited without a result event: ${managed.stderr.trim()}`
            : 'Reasonix exited without emitting a result event.',
          { stderr: managed.stderr, exitCode: managed.exitCode },
        );
      }

      if (managed.reusable && managed.sessionId) {
        await writeReasonixTranscriptMetadata(entry, {
          sessionId: managed.sessionId,
          cwd,
          model: options.model,
          prompt,
        }).catch(() => undefined);
        this.reasonixManagedEntries.set(
          reasonixManagedAliasKey(configFingerprint, cwd, managed.sessionId),
          entry,
        );
      } else if (!managed.reusable) {
        await this.releaseReasonixEntry(entry);
      }

      const assistantMessages = retainedAssistantMessages.toArray();
      return {
        text: deriveResultText(resultEvent, assistantMessages),
        sessionId:
          getNonEmptyStringValue(resultEvent, 'session_id')
          ?? getNonEmptyStringValue(initEvent, 'session_id')
          ?? managed.sessionId,
        isError: getBooleanValue(resultEvent, 'is_error') ?? false,
        subtype: getStringValue(resultEvent, 'subtype'),
        stopReason: getStringValue(resultEvent, 'stop_reason'),
        durationMs: getNumberValue(resultEvent, 'duration_ms'),
        totalCostUsd: getNumberValue(resultEvent, 'total_cost_usd'),
        numTurns: getNumberValue(resultEvent, 'num_turns'),
        exitCode: managed.exitCode,
        stderr: managed.stderr,
        initEvent,
        resultEvent,
        assistantMessages,
        events: retainedEvents.toArray(),
      };
    } catch (error) {
      await this.releaseReasonixEntry(entry);
      const normalized = asError(error);
      if (options.signal?.aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Reasonix managed run was aborted.', { cause: error });
      }
      if (error instanceof ActoviqBridgeProcessError) throw error;
      throw new ActoviqBridgeProcessError(normalized.message, { cause: error });
    }
  }

  private async getOrCreateReasonixEntry(
    aliasKey: string,
    configFingerprint: string,
    cwd: string,
    nativeSessionId: string | undefined,
    options: ActoviqBridgeRunOptions,
  ): Promise<ManagedReasonixEntry> {
    const cached = this.reasonixManagedEntries.get(aliasKey);
    if (cached) return cached;
    const pending = this.reasonixManagedEntryPromises.get(aliasKey);
    if (pending) return pending;

    const creation = (async () => {
      const childEnvironment = await buildChildEnvironment(this.provider, options, true);
      try {
        const cliArgs = this.provider.buildArgs('', options);
        const transcriptRoot = path.join(
          await persistentExternalCliProfile(this.provider, options),
          '.reasonix',
          'sessions',
        );
        await ensurePrivateDirectory(transcriptRoot);
        const transcriptIdentity = nativeSessionId
          ? createHash('sha256').update(nativeSessionId).digest('hex').slice(0, 32)
          : randomUUID();
        const transcriptPath = path.join(
          transcriptRoot,
          `managed-${transcriptIdentity}.jsonl`,
        );
        cliArgs.push('--dir', cwd, '--transcript', transcriptPath);
        const args = this.cliPath ? [this.cliPath, ...cliArgs] : cliArgs;
        const invocation = await resolveExecutableInvocation(
          options.executable ?? this.executable,
          args,
        );
        if (this.closed) {
          throw new ActoviqBridgeProcessError('The Actoviq Runtime client is closed.');
        }
        const client = createReasonixManagedClient({
          executable: invocation.file,
          args: invocation.args,
          cwd,
          env: childEnvironment.env,
          nativeSessionId,
          secrets: childEnvironment.secrets,
          onSpawn: child => {
            this.activeChildren.add(child as ReturnType<typeof spawn>);
            child.once('close', () => {
              this.activeChildren.delete(child as ReturnType<typeof spawn>);
            });
          },
        });
        const entry: ManagedReasonixEntry = {
          client,
          transcriptPath,
          transcriptCreatedAt: new Date().toISOString(),
          cleanup: childEnvironment.cleanup,
        };
        this.reasonixManagedEntries.set(aliasKey, entry);
        return entry;
      } catch (error) {
        await childEnvironment.cleanup?.();
        throw error;
      }
    })();
    this.reasonixManagedEntryPromises.set(aliasKey, creation);
    try {
      return await creation;
    } finally {
      if (this.reasonixManagedEntryPromises.get(aliasKey) === creation) {
        this.reasonixManagedEntryPromises.delete(aliasKey);
      }
    }
  }

  private async releaseReasonixEntry(entry: ManagedReasonixEntry): Promise<void> {
    for (const [key, candidate] of this.reasonixManagedEntries) {
      if (candidate === entry) this.reasonixManagedEntries.delete(key);
    }
    if (!entry.cleanupPromise) {
      entry.cleanupPromise = (async () => {
        await entry.client.close().catch(() => undefined);
        await entry.cleanup?.().catch(() => undefined);
      })();
    }
    await entry.cleanupPromise;
  }

  private async executeManagedCrush(
    prompt: string,
    options: ActoviqBridgeRunOptions,
    controller: {
      emit: (event: ActoviqBridgeJsonEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    },
  ): Promise<ActoviqBridgeRunResult> {
    assertManagedOptionsSupported('Crush', options, ['effort', 'maxBudgetUsd']);
    if (options.forkSession) {
      throw new ActoviqBridgeProcessError(
        'Crush managed mode does not expose a native session-fork operation.',
      );
    }
    if (options.resume === true || options.continueMostRecent) {
      throw new ActoviqBridgeProcessError(
        'Crush managed mode requires an exact native session id to resume.',
      );
    }

    const cwd = path.resolve(options.workDir ?? this.defaults.workDir ?? process.cwd());
    if (options.trustProjectResources !== true) {
      const projectConfig = await findCrushProjectConfig(cwd);
      if (projectConfig) {
        throw new ActoviqBridgeProcessError(
          `Crush project config requires trustProjectResources: ${projectConfig}`,
        );
      }
    }

    const childEnvironment = await buildChildEnvironment(this.provider, options, true);
    const retainedEvents = new BoundedRetention<ActoviqBridgeJsonEvent>(MAX_RETAINED_RUN_EVENTS);
    const retainedAssistantMessages = new BoundedRetention<ActoviqBridgeJsonEvent>(
      MAX_RETAINED_ASSISTANT_MESSAGES,
    );
    let initEvent: ActoviqBridgeJsonEvent | undefined;
    let resultEvent: ActoviqBridgeJsonEvent | undefined;

    const onEvent = (event: ActoviqBridgeJsonEvent): void => {
      retainedEvents.push(structuredClone(event));
      if (event.type === 'system' && event.subtype === 'init') {
        initEvent = structuredClone(event);
      }
      if (event.type === 'assistant') {
        retainedAssistantMessages.push(structuredClone(event));
      }
      if (event.type === 'result') {
        resultEvent = structuredClone(event);
      }
      controller.emit(event);
    };

    try {
      const credentialProvider = credentialProviderHint(options);
      const explicitApiKeyMode = (options.authSource ?? 'native') === 'apiKey';
      const credentialKeys = providerCredentialKeys(this.provider, options);
      const credentialBaseUrlKeys = credentialKeys
        .map(key => key.replace(/_API_KEY$/u, '_BASE_URL'));
      const managed = await runCrushManaged({
        executable: options.executable ?? this.executable,
        executableArgs: this.cliPath ? [this.cliPath] : undefined,
        cwd,
        prompt,
        nativeSessionId: typeof options.resume === 'string' ? options.resume : undefined,
        model: crushManagedModel(options, credentialProvider),
        credentialProvider,
        apiKey: explicitApiKeyMode
          ? environmentValue(childEnvironment.env, credentialKeys)
          : undefined,
        baseURL: explicitApiKeyMode
          ? options.baseURL
            ?? environmentValue(childEnvironment.env, credentialBaseUrlKeys)
          : undefined,
        permissionMode: options.dangerouslySkipPermissions
          ? 'bypassPermissions'
          : options.permissionMode,
        env: childEnvironment.env,
        inheritEnvironment: false,
        signal: options.signal,
        spawnFn: (file, args, spawnOptions) => {
          const child = spawn(file, [...args], spawnOptions);
          this.activeChildren.add(child);
          child.once('close', () => this.activeChildren.delete(child));
          return child;
        },
      }, onEvent);

      if (!resultEvent) {
        throw new ActoviqBridgeProcessError(
          managed.stderr.trim()
            ? `Crush exited without a result event: ${managed.stderr.trim()}`
            : 'Crush exited without emitting a result event.',
          { stderr: managed.stderr, exitCode: managed.exitCode },
        );
      }

      const assistantMessages = retainedAssistantMessages.toArray();
      return {
        text: deriveResultText(resultEvent, assistantMessages),
        sessionId:
          getStringValue(resultEvent, 'session_id')
          ?? getStringValue(initEvent, 'session_id')
          ?? managed.sessionId,
        isError: getBooleanValue(resultEvent, 'is_error') ?? false,
        subtype: getStringValue(resultEvent, 'subtype'),
        stopReason: getStringValue(resultEvent, 'stop_reason'),
        durationMs: getNumberValue(resultEvent, 'duration_ms'),
        totalCostUsd: getNumberValue(resultEvent, 'total_cost_usd'),
        numTurns: getNumberValue(resultEvent, 'num_turns'),
        exitCode: managed.exitCode,
        stderr: managed.stderr,
        initEvent,
        resultEvent,
        assistantMessages,
        events: retainedEvents.toArray(),
      };
    } catch (error) {
      const normalized = asError(error);
      if (options.signal?.aborted || isAbortErrorLike(normalized)) {
        throw new RunAbortedError('The Crush managed run was aborted.', { cause: error });
      }
      if (error instanceof ActoviqBridgeProcessError) throw error;
      throw new ActoviqBridgeProcessError(
        redactText(normalized.message, childEnvironment.secrets),
        { cause: error },
      );
    } finally {
      await childEnvironment.cleanup?.();
    }
  }
}

export async function createActoviqBridgeSdk(
  options: CreateActoviqBridgeSdkOptions = {},
): Promise<ActoviqBridgeSdkClient> {
  return ActoviqBridgeSdkClient.create(options);
}
