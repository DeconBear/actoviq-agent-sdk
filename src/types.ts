import type {
  ContentBlock,
  Message,
  MessageParam,
  MessageStreamEvent,
  Metadata,
  StopReason,
  Tool as ProviderTool,
  ToolChoice,
  ToolResultBlockParam,
  Usage,
} from './provider/types.js';
import type { z } from 'zod';

export interface LoadedJsonConfigData {
  path: string;
  exists: boolean;
  env: Record<string, string>;
  permissions?: Record<string, unknown>;
  raw: Record<string, unknown> | null;
}

export type ActoviqSettingsData = LoadedJsonConfigData;

export interface ToolExecutionContext {
  signal?: AbortSignal;
  runId: string;
  sessionId?: string;
  cwd: string;
  metadata: Record<string, unknown>;
  prompt: string;
  iteration: number;
}

export interface CreateToolOptions<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  serialize?: (output: Output) => string | ToolResultBlockParam['content'];
  strict?: boolean;
  examples?: Array<Record<string, unknown>>;
}

export interface AgentToolDefinition<Input = any, Output = any> {
  kind: 'local';
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  inputJsonSchema: Record<string, unknown>;
  serialize?: (output: Output) => string | ToolResultBlockParam['content'];
  execute: (input: Input, context: ToolExecutionContext) => Promise<Output> | Output;
  strict?: boolean;
  examples?: Array<Record<string, unknown>>;
}

export interface LocalMcpServerDefinition {
  kind: 'local';
  name: string;
  tools: AgentToolDefinition[];
  prefix?: string;
}

export interface StdioMcpServerDefinition {
  kind: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  prefix?: string;
  stderr?: 'inherit' | 'ignore' | 'pipe';
}

export interface StreamableHttpMcpServerDefinition {
  kind: 'streamable_http';
  name: string;
  url: string | URL;
  headers?: Record<string, string>;
  sessionId?: string;
  prefix?: string;
}

export type AgentMcpServerDefinition =
  | LocalMcpServerDefinition
  | StdioMcpServerDefinition
  | StreamableHttpMcpServerDefinition;

export interface ModelRequest {
  model: string;
  messages: MessageParam[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  tools?: ProviderTool[];
  tool_choice?: ToolChoice;
  metadata?: Metadata;
  stop_sequences?: string[];
  signal?: AbortSignal;
}

export interface ModelStreamHandle extends AsyncIterable<MessageStreamEvent> {
  finalMessage(): Promise<Message>;
}

export interface ModelApi {
  createMessage(request: ModelRequest): Promise<Message>;
  streamMessage(request: ModelRequest): ModelStreamHandle;
}

export interface ResolvedToolExecutionResult {
  content?: ToolResultBlockParam['content'];
  text: string;
  rawOutput?: unknown;
  isError?: boolean;
}

export interface ResolvedToolAdapter {
  publicName: string;
  sourceName: string;
  provider: 'local' | 'mcp';
  mcpServerName?: string;
  providerTool: ProviderTool;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<ResolvedToolExecutionResult>;
}

export interface ResolvedRuntimeConfig {
  homeDir: string;
  loadedConfigPath?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  maxRetries: number;
  workDir: string;
  sessionDirectory: string;
  clientName: string;
  clientVersion: string;
  systemPrompt?: string;
  maxToolIterations: number;
  userId?: string;
  metadata: Record<string, unknown>;
}

export interface CreateAgentSdkOptions {
  homeDir?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  workDir?: string;
  sessionDirectory?: string;
  clientName?: string;
  clientVersion?: string;
  systemPrompt?: string;
  maxToolIterations?: number;
  userId?: string;
  metadata?: Record<string, unknown>;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  modelApi?: ModelApi;
}

export type ActoviqWorkspaceKind = 'directory' | 'temp' | 'git-worktree';

export interface ActoviqWorkspaceInfo {
  id: string;
  kind: ActoviqWorkspaceKind;
  path: string;
  metadata: Record<string, string>;
}

export interface CreateWorkspaceOptions {
  path: string;
  ensureExists?: boolean;
  copyFrom?: string;
  metadata?: Record<string, string>;
}

export interface CreateTempWorkspaceOptions {
  prefix?: string;
  parentDir?: string;
  copyFrom?: string;
  metadata?: Record<string, string>;
}

export interface CreateGitWorktreeWorkspaceOptions {
  repositoryPath: string;
  path?: string;
  parentDir?: string;
  name?: string;
  ref?: string;
  branch?: string;
  detach?: boolean;
  force?: boolean;
  metadata?: Record<string, string>;
}

export interface AgentRunOptions {
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  toolChoice?: ToolChoice;
  userId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface SessionCreateOptions {
  title?: string;
  systemPrompt?: string;
  model?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  initialMessages?: MessageParam[];
}

export interface SessionForkOptions {
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentRequestSummary {
  iteration: number;
  messageId: string;
  model: string;
  stopReason: StopReason | null;
  usage?: Usage;
  text: string;
  createdAt: string;
}

export interface AgentToolCallEventPayload {
  id: string;
  name: string;
  publicName: string;
  provider: 'local' | 'mcp';
  mcpServerName?: string;
  input: unknown;
  startedAt: string;
}

export interface AgentToolCallRecord extends AgentToolCallEventPayload {
  outputText: string;
  output?: unknown;
  isError: boolean;
  completedAt: string;
  durationMs: number;
}

export interface AgentRunResult {
  runId: string;
  sessionId?: string;
  model: string;
  text: string;
  message: Message;
  messages: MessageParam[];
  stopReason: StopReason | null;
  usage?: Usage;
  requests: AgentRequestSummary[];
  toolCalls: AgentToolCallRecord[];
  startedAt: string;
  completedAt: string;
}

export type AgentEvent =
  | {
      type: 'run.started';
      runId: string;
      sessionId?: string;
      model: string;
      input: string;
      timestamp: string;
    }
  | {
      type: 'request.started';
      runId: string;
      iteration: number;
      timestamp: string;
    }
  | {
      type: 'response.text.delta';
      runId: string;
      iteration: number;
      delta: string;
      snapshot: string;
      timestamp: string;
    }
  | {
      type: 'response.content';
      runId: string;
      iteration: number;
      content: ContentBlock;
      timestamp: string;
    }
  | {
      type: 'response.message';
      runId: string;
      iteration: number;
      message: Message;
      timestamp: string;
    }
  | {
      type: 'tool.call';
      runId: string;
      iteration: number;
      call: AgentToolCallEventPayload;
      timestamp: string;
    }
  | {
      type: 'tool.result';
      runId: string;
      iteration: number;
      result: AgentToolCallRecord;
      timestamp: string;
    }
  | {
      type: 'response.completed';
      runId: string;
      result: AgentRunResult;
      timestamp: string;
    }
  | {
      type: 'error';
      runId: string;
      error: {
        message: string;
        code?: string;
        stack?: string;
      };
      timestamp: string;
    };

export interface StoredRunSummary {
  runId: string;
  input: string;
  text: string;
  stopReason: StopReason | null;
  createdAt: string;
  completedAt: string;
  toolCallCount: number;
  usage?: Usage;
}

export interface StoredSession {
  version: 1;
  id: string;
  title: string;
  titleSource: 'auto' | 'manual';
  model: string;
  systemPrompt?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  messages: MessageParam[];
  runs: StoredRunSummary[];
}

export interface SessionSummary {
  id: string;
  title: string;
  titleSource: 'auto' | 'manual';
  model: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  tags: string[];
  preview: string;
  messageCount: number;
  runCount: number;
}

export type ActoviqBridgePermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

export type ActoviqBridgeToolsOption = 'default' | 'none' | string[];

export interface ActoviqBridgeJsonEvent extends Record<string, unknown> {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
}

export interface CreateActoviqBridgeSdkOptions {
  executable?: string;
  cliPath?: string;
  homeDir?: string;
  workDir?: string;
  model?: string;
  fallbackModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: ActoviqBridgePermissionMode;
  dangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  agent?: string;
  agents?: Record<string, unknown>;
  tools?: ActoviqBridgeToolsOption;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  mcpConfigs?: Array<string | Record<string, unknown>>;
  strictMcpConfig?: boolean;
  settings?: string | Record<string, unknown>;
  settingSources?: string;
  jsonSchema?: string | Record<string, unknown>;
  files?: string[];
  bare?: boolean;
  disableSlashCommands?: boolean;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  verbose?: boolean;
  pluginDirs?: string[];
  env?: Record<string, string>;
  cliArgs?: string[];
}

export interface ActoviqBridgeRunOptions extends CreateActoviqBridgeSdkOptions {
  sessionId?: string;
  resume?: string | true;
  continueMostRecent?: boolean;
  forkSession?: boolean;
  name?: string;
  signal?: AbortSignal;
}

export interface ActoviqBridgeSessionCreateOptions
  extends Omit<
    ActoviqBridgeRunOptions,
    'continueMostRecent' | 'forkSession' | 'name' | 'resume' | 'sessionId' | 'signal'
  > {
  sessionId?: string;
  title?: string;
}

export type ActoviqBridgeAgentRunOptions = Omit<ActoviqBridgeRunOptions, 'agent'>;

export type ActoviqBridgeAgentSessionOptions = Omit<ActoviqBridgeSessionCreateOptions, 'agent'>;

export type ActoviqBridgeSkillRunOptions = Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>;

export interface ActoviqBridgeRunResult {
  text: string;
  sessionId: string;
  isError: boolean;
  subtype?: string;
  stopReason?: string;
  durationMs?: number;
  totalCostUsd?: number;
  numTurns?: number;
  exitCode: number | null;
  stderr: string;
  initEvent?: ActoviqBridgeJsonEvent;
  resultEvent: ActoviqBridgeJsonEvent;
  assistantMessages: ActoviqBridgeJsonEvent[];
  events: ActoviqBridgeJsonEvent[];
}

export interface ActoviqRuntimeMcpServer {
  name: string;
  status?: string;
}

export interface ActoviqRuntimePluginInfo {
  name: string;
  path?: string;
  source?: string;
}

export interface ActoviqRuntimeInfo {
  sessionId: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools: string[];
  mcpServers: ActoviqRuntimeMcpServer[];
  slashCommands: string[];
  agents: string[];
  skills: string[];
  plugins: ActoviqRuntimePluginInfo[];
  rawInitEvent: ActoviqBridgeJsonEvent;
}

export interface ActoviqAgentSummary {
  name: string;
  sourceGroup: string;
  active: boolean;
  rawLine: string;
  model?: string;
  memory?: string;
  shadowedBy?: string;
}

export interface ActoviqAgentMetadata extends ActoviqAgentSummary {
  contextSource?: string;
  tokens?: string;
}

export interface ActoviqToolMetadata {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  tokens?: string;
}

export interface ActoviqSkillMetadata {
  name: string;
  slashCommand: string;
  source?: string;
  tokens?: string;
}

export interface ActoviqSlashCommandMetadata {
  name: string;
  kind: 'builtin' | 'skill';
  skillName?: string;
}

export interface ActoviqRuntimeCatalog {
  runtime: ActoviqRuntimeInfo;
  agents: ActoviqAgentMetadata[];
  tools: ActoviqToolMetadata[];
  skills: ActoviqSkillMetadata[];
  slashCommands: ActoviqSlashCommandMetadata[];
  context?: ActoviqContextUsage;
}

export interface ActoviqContextCategory {
  name: string;
  tokens: string;
  percentage: string;
}

export interface ActoviqContextSkillUsage {
  name: string;
  source?: string;
  tokens: string;
}

export interface ActoviqContextAgentUsage {
  agentType: string;
  source?: string;
  tokens: string;
}

export interface ActoviqContextMcpToolUsage {
  tool: string;
  server: string;
  tokens: string;
}

export interface ActoviqContextUsage {
  markdown: string;
  model?: string;
  tokensUsed?: string;
  tokenLimit?: string;
  percentage?: number;
  categories: ActoviqContextCategory[];
  skills: ActoviqContextSkillUsage[];
  agents: ActoviqContextAgentUsage[];
  mcpTools: ActoviqContextMcpToolUsage[];
  rawResult: ActoviqBridgeRunResult;
}

export interface ActoviqBridgeCapabilityLookupOptions
  extends Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> {
  includeContext?: boolean;
}

export type ActoviqBridgeToolProvider = 'runtime' | 'server' | 'mcp' | 'unknown';

export interface ActoviqBridgeToolRequest {
  id?: string;
  name: string;
  provider: ActoviqBridgeToolProvider;
  blockType: string;
  input?: unknown;
}

export interface ActoviqBridgeToolResultSummary {
  toolUseId: string;
  isError: boolean;
  blockType: string;
  content?: unknown;
}

export interface ActoviqBridgeTaskInvocation {
  id?: string;
  name: string;
  provider: ActoviqBridgeToolProvider;
  description?: string;
  prompt?: string;
  subagentType?: string;
  input: Record<string, unknown>;
}

export interface ActoviqBridgeEventAnalysis {
  textDeltas: string[];
  toolRequests: ActoviqBridgeToolRequest[];
  toolResults: ActoviqBridgeToolResultSummary[];
  taskInvocations: ActoviqBridgeTaskInvocation[];
}

export interface ActoviqMemorySettings {
  autoCompactEnabled?: boolean;
  autoMemoryEnabled?: boolean;
  autoDreamEnabled?: boolean;
  autoMemoryDirectory?: string;
}

export interface UpdateActoviqMemorySettingsInput {
  autoCompactEnabled?: boolean;
  autoMemoryEnabled?: boolean;
  autoDreamEnabled?: boolean;
  autoMemoryDirectory?: string | null;
}

export interface ActoviqMemoryPaths {
  configPath: string;
  homeDir: string;
  projectPath: string;
  memoryBaseDir: string;
  projectStateDir: string;
  autoMemoryDir: string;
  autoMemoryEntrypoint: string;
  teamMemoryDir: string;
  teamMemoryEntrypoint: string;
  sessionId?: string;
  sessionMemoryDir?: string;
  sessionMemoryPath?: string;
}

export interface ActoviqSessionMemoryState {
  exists: boolean;
  path?: string;
  content?: string;
  isEmpty?: boolean;
  tokenEstimate?: number;
  truncatedContent?: string;
  wasTruncated?: boolean;
}

export interface ActoviqSessionMemoryConfig {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenUpdate: number;
  toolCallsBetweenUpdates: number;
}

export interface ActoviqSessionMemoryCompactConfig {
  minTokens: number;
  minTextBlockMessages: number;
  maxTokens: number;
}

export interface ActoviqSessionMemoryProgress {
  currentTokenCount?: number;
  tokensAtLastExtraction?: number;
  tokensSinceLastExtraction?: number;
  toolCallsSinceLastUpdate?: number;
  initialized: boolean;
  meetsInitializationThreshold?: boolean;
  meetsUpdateThreshold?: boolean;
  meetsToolCallThreshold?: boolean;
  shouldExtract?: boolean;
}

export interface ActoviqMemoryOptions {
  configPath?: string;
  homeDir?: string;
  projectPath?: string;
  sessionId?: string;
}

export interface ActoviqMemoryPromptOptions extends ActoviqMemoryOptions {
  extraGuidelines?: string[];
  skipIndex?: boolean;
}

export interface ActoviqMemoryStateOptions extends ActoviqMemoryPromptOptions {
  includeCombinedPrompt?: boolean;
  includeSessionMemory?: boolean;
  includeSessionTemplate?: boolean;
  includeSessionPrompt?: boolean;
}

export interface ActoviqCompactStateOptions extends ActoviqMemoryStateOptions {
  includeBoundaries?: boolean;
  includeSummaryMessage?: boolean;
  currentTokenCount?: number;
  tokensAtLastExtraction?: number;
  initialized?: boolean;
  toolCallsSinceLastUpdate?: number;
}

export interface ActoviqMemoryState {
  settings: ActoviqMemorySettings;
  enabled: {
    autoCompact: boolean;
    autoMemory: boolean;
    autoDream: boolean;
  };
  paths: ActoviqMemoryPaths;
  combinedPrompt?: string;
  sessionMemory?: ActoviqSessionMemoryState;
  sessionTemplate?: string;
  sessionPrompt?: string;
}

export interface ActoviqCompactState extends ActoviqMemoryState {
  sessionMemoryConfig: ActoviqSessionMemoryConfig;
  sessionMemoryCompactConfig: ActoviqSessionMemoryCompactConfig;
  progress?: ActoviqSessionMemoryProgress;
  transcriptPath?: string;
  boundaries?: ActoviqTranscriptBoundary[];
  latestBoundary?: ActoviqTranscriptBoundary;
  compactCount: number;
  microcompactCount: number;
  hasCompacted: boolean;
  lastSummarizedMessageUuid?: string;
  latestBoundarySummary?: string;
  canUseSessionMemoryCompaction: boolean;
  summaryMessage?: string;
}

export interface ActoviqMemoryFileHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description?: string | null;
  type?: string;
  scope: 'private' | 'team';
}

export interface ActoviqRelevantMemory {
  filename: string;
  path: string;
  mtimeMs: number;
  description?: string | null;
  type?: string;
  scope: 'private' | 'team';
  score?: number;
}

export interface ActoviqSurfacedMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
  limit?: number;
  scope: 'private' | 'team';
  freshnessText?: string;
}

export interface ActoviqRelevantMemoryLookupOptions extends ActoviqMemoryOptions {
  recentTools?: string[];
  alreadySurfacedPaths?: Iterable<string>;
  limit?: number;
}

export interface ActoviqCompactBoundaryMetadata {
  trigger?: string;
  preTokens?: number;
  userContext?: string;
  messagesSummarized?: number;
}

export interface ActoviqMicrocompactBoundaryMetadata {
  trigger?: string;
  preTokens?: number;
  tokensSaved?: number;
  compactedToolIds?: string[];
  clearedAttachmentUUIDs?: string[];
}

export interface ActoviqTranscriptBoundary {
  kind: 'compact' | 'microcompact';
  uuid: string;
  timestamp: string;
  sessionId: string;
  logicalParentUuid?: string | null;
  metadata?: ActoviqCompactBoundaryMetadata | ActoviqMicrocompactBoundaryMetadata;
  raw: Record<string, unknown>;
}

export const ACTOVIQ_BUDDY_RARITIES = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const;
export type ActoviqBuddyRarity = (typeof ACTOVIQ_BUDDY_RARITIES)[number];

export const ACTOVIQ_BUDDY_SPECIES = [
  'duck',
  'goose',
  'blob',
  'cat',
  'dragon',
  'octopus',
  'owl',
  'penguin',
  'turtle',
  'snail',
  'ghost',
  'axolotl',
  'capybara',
  'cactus',
  'robot',
  'rabbit',
  'mushroom',
  'chonk',
] as const;
export type ActoviqBuddySpecies = (typeof ACTOVIQ_BUDDY_SPECIES)[number];

export const ACTOVIQ_BUDDY_EYES = ['o_o', '^_^', '-_-', '@_@', '>_<', 'x_x'] as const;
export type ActoviqBuddyEye = (typeof ACTOVIQ_BUDDY_EYES)[number];

export const ACTOVIQ_BUDDY_HATS = [
  'none',
  'crown',
  'tophat',
  'propeller',
  'halo',
  'wizard',
  'beanie',
  'tinyduck',
] as const;
export type ActoviqBuddyHat = (typeof ACTOVIQ_BUDDY_HATS)[number];

export const ACTOVIQ_BUDDY_STAT_NAMES = [
  'DEBUGGING',
  'PATIENCE',
  'CHAOS',
  'WISDOM',
  'SNARK',
] as const;
export type ActoviqBuddyStatName = (typeof ACTOVIQ_BUDDY_STAT_NAMES)[number];

export interface ActoviqBuddyBones {
  rarity: ActoviqBuddyRarity;
  species: ActoviqBuddySpecies;
  eye: ActoviqBuddyEye;
  hat: ActoviqBuddyHat;
  shiny: boolean;
  stats: Record<ActoviqBuddyStatName, number>;
}

export interface ActoviqBuddySoul {
  name: string;
  personality: string;
}

export interface StoredActoviqBuddy extends ActoviqBuddySoul {
  hatchedAt: number;
}

export interface ActoviqBuddyCompanion extends ActoviqBuddyBones, ActoviqBuddySoul {
  hatchedAt: number;
}

export interface ActoviqBuddyRoll {
  bones: ActoviqBuddyBones;
  inspirationSeed: number;
}

export interface ActoviqBuddyState {
  configPath: string;
  userId: string;
  muted: boolean;
  buddy?: ActoviqBuddyCompanion;
}

export interface ActoviqBuddyReaction {
  buddy: ActoviqBuddyCompanion;
  reaction: string;
  petAt: number;
}

export interface ActoviqBuddyIntroAttachment {
  type: 'companion_intro';
  name: string;
  species: ActoviqBuddySpecies;
}

export interface ActoviqBuddyPromptContext {
  buddy: ActoviqBuddyCompanion;
  attachment: ActoviqBuddyIntroAttachment;
  text: string;
}

export interface ActoviqBuddyOptions {
  configPath?: string;
  homeDir?: string;
  userId?: string;
}

export interface HatchActoviqBuddyOptions extends ActoviqBuddyOptions {
  name: string;
  personality: string;
}

export interface ActoviqBuddyPromptContextOptions extends ActoviqBuddyOptions {
  announcedNames?: string[];
}





