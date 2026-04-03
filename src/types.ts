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
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
  hooks?: ActoviqHooks;
}

export type ActoviqPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'auto';

export type ActoviqPermissionBehavior = 'allow' | 'deny' | 'ask';

export interface ActoviqPermissionRule {
  toolName: string;
  behavior: ActoviqPermissionBehavior;
  matcher?: string;
  source?: string;
}

export interface ActoviqPermissionDecision {
  toolName: string;
  publicName: string;
  behavior: 'allow' | 'deny';
  reason: string;
  source: 'mode' | 'rule' | 'classifier' | 'approver';
  matchedRule?: string;
  timestamp: string;
}

export type ActoviqClassifierOutcome =
  | {
      behavior: 'allow' | 'deny' | 'ask';
      reason: string;
    };

export interface ActoviqToolClassifierContext {
  runId: string;
  sessionId?: string;
  workDir: string;
  toolName: string;
  publicName: string;
  input: unknown;
  prompt: string;
  iteration: number;
}

export type ActoviqToolClassifier = (
  context: ActoviqToolClassifierContext,
) => Promise<ActoviqClassifierOutcome | void> | ActoviqClassifierOutcome | void;

export interface ActoviqToolApprovalContext extends ActoviqToolClassifierContext {
  mode: ActoviqPermissionMode;
  proposedBehavior: 'ask';
  reason: string;
  source: 'rule' | 'classifier';
  matchedRule?: string;
}

export type ActoviqToolApprovalOutcome =
  | {
      behavior: 'allow' | 'deny';
      reason?: string;
    };

export type ActoviqToolApprover = (
  context: ActoviqToolApprovalContext,
) =>
  | Promise<ActoviqToolApprovalOutcome | void>
  | ActoviqToolApprovalOutcome
  | void;

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
  context_management?: Record<string, unknown>;
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
  compact: ActoviqCompactConfig;
}

export interface ActoviqSessionStartHookContext {
  runId: string;
  input: string | MessageParam['content'];
  promptText: string;
  sessionId?: string;
  session?: StoredSession;
  workDir: string;
  options: AgentRunOptions;
}

export interface ActoviqSessionStartHookResult {
  messages?: MessageParam[];
  systemPromptParts?: string[];
  metadata?: Record<string, unknown>;
}

export type ActoviqSessionStartHook =
  | ((
      context: ActoviqSessionStartHookContext,
    ) => Promise<ActoviqSessionStartHookResult | void> | ActoviqSessionStartHookResult | void);

export interface ActoviqPostRunHookContext {
  runId: string;
  input: string | MessageParam['content'];
  promptText: string;
  sessionId?: string;
  session?: StoredSession;
  workDir: string;
  options: AgentRunOptions;
  result: AgentRunResult;
}

export interface ActoviqPostRunHookResult {
  sessionMetadata?: Record<string, unknown>;
  tags?: string[];
}

export type ActoviqPostRunHook =
  | ((
      context: ActoviqPostRunHookContext,
    ) => Promise<ActoviqPostRunHookResult | void> | ActoviqPostRunHookResult | void);

export interface ActoviqPostSamplingHookContext {
  runId: string;
  sessionId?: string;
  workDir: string;
  iteration: number;
  input: string | MessageParam['content'];
  promptText: string;
  options: AgentRunOptions;
  systemPrompt?: string;
  assistantMessage: Message;
  messages: MessageParam[];
}

export type ActoviqPostSamplingHook =
  | ((
      context: ActoviqPostSamplingHookContext,
    ) => Promise<void> | void);

export interface ActoviqHooks {
  sessionStart?: ActoviqSessionStartHook[];
  postSampling?: ActoviqPostSamplingHook[];
  postRun?: ActoviqPostRunHook[];
}

export interface ActoviqAgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  hooks?: ActoviqHooks;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  inheritDefaultTools?: boolean;
  inheritDefaultMcpServers?: boolean;
}

export interface ActoviqAgentDefinitionSummary {
  name: string;
  description: string;
  model?: string;
  toolNames: string[];
  mcpServerNames: string[];
  inheritDefaultTools: boolean;
  inheritDefaultMcpServers: boolean;
  metadataKeys: string[];
  hasSystemPrompt: boolean;
  hasHooks: boolean;
}

export type ActoviqSkillSource = 'bundled' | 'user' | 'project' | 'custom';

export type ActoviqSkillLoadedFrom =
  | 'bundled'
  | 'skills'
  | 'commands'
  | 'custom';

export type ActoviqSkillContextMode = 'inline' | 'fork';

export interface ActoviqSkillPromptContext {
  args: string;
  workDir: string;
  homeDir: string;
  sessionId?: string;
  userId?: string;
}

export interface ActoviqSkillPromptBuildResult {
  content: string | MessageParam['content'];
  systemPromptParts?: string[];
  metadata?: Record<string, unknown>;
}

export type ActoviqSkillPromptBuilder = (
  args: string,
  context: ActoviqSkillPromptContext,
) =>
  | Promise<string | MessageParam['content'] | ActoviqSkillPromptBuildResult>
  | string
  | MessageParam['content']
  | ActoviqSkillPromptBuildResult;

export interface ActoviqSkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argNames?: string[];
  prompt?: string;
  buildPrompt?: ActoviqSkillPromptBuilder;
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  source?: ActoviqSkillSource;
  loadedFrom?: ActoviqSkillLoadedFrom;
  context?: ActoviqSkillContextMode;
  agent?: string;
  hooks?: ActoviqHooks;
  metadata?: Record<string, unknown>;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  inheritDefaultTools?: boolean;
  inheritDefaultMcpServers?: boolean;
  allowedTools?: string[];
  paths?: string[];
  skillRoot?: string;
}

export interface ActoviqSkillDefinitionSummary {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argNames: string[];
  model?: string;
  source: ActoviqSkillSource;
  loadedFrom: ActoviqSkillLoadedFrom;
  context: ActoviqSkillContextMode;
  agent?: string;
  allowedTools: string[];
  metadataKeys: string[];
  hasPrompt: boolean;
  hasHooks: boolean;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  skillRoot?: string;
  paths?: string[];
}

export interface ActoviqInvokedSkillRecord {
  name: string;
  args?: string;
  content: string;
  invokedAt: string;
  source: ActoviqSkillSource;
  loadedFrom: ActoviqSkillLoadedFrom;
  context: ActoviqSkillContextMode;
  model?: string;
  agent?: string;
  skillRoot?: string;
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
  agents?: ActoviqAgentDefinition[];
  skills?: ActoviqSkillDefinition[];
  skillDirectories?: string[];
  disableDefaultSkills?: boolean;
  loadDefaultSkillDirectories?: boolean;
  hooks?: ActoviqHooks;
  compact?: Partial<ActoviqCompactConfig>;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
  computerUse?: boolean | CreateActoviqComputerUseOptions;
  modelApi?: ModelApi;
}

export interface ActoviqCompactConfig {
  enabled: boolean;
  autoCompactThresholdTokens: number;
  preserveRecentMessages: number;
  maxSummaryTokens: number;
  microcompactEnabled: boolean;
  microcompactKeepRecentToolResults: number;
  microcompactMinContentChars: number;
  apiMicrocompactEnabled?: boolean;
  apiMicrocompactMaxInputTokens?: number;
  apiMicrocompactTargetInputTokens?: number;
  apiMicrocompactClearToolResults?: boolean;
  apiMicrocompactClearToolUses?: boolean;
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
  hooks?: ActoviqHooks;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
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
  surfacedMemories?: ActoviqSurfacedMemory[];
  stopReason: StopReason | null;
  usage?: Usage;
  requests: AgentRequestSummary[];
  toolCalls: AgentToolCallRecord[];
  startedAt: string;
  completedAt: string;
  sessionHookMetadata?: Record<string, unknown>;
  delegatedAgents?: ActoviqDelegatedAgentRecord[];
  invokedSkills?: ActoviqInvokedSkillRecord[];
  reactiveCompact?: ActoviqSessionCompactResult;
  permissionDecisions?: ActoviqPermissionDecision[];
}

export type ActoviqCompactTrigger = 'auto' | 'manual' | 'reactive';

export interface AgentSessionCompactOptions {
  force?: boolean;
  model?: string;
  maxTokens?: number;
  preserveRecentMessages?: number;
  summaryInstructions?: string;
  signal?: AbortSignal;
}

export interface ActoviqSessionCompactResult {
  compacted: boolean;
  trigger: ActoviqCompactTrigger;
  reason:
    | 'disabled'
    | 'threshold_not_met'
    | 'no_messages'
    | 'compacted';
  tokenEstimateBefore: number;
  tokenEstimateAfter?: number;
  summaryMessage?: string;
  messagesRemoved?: number;
  compactCount: number;
  microcompactCount: number;
  state: ActoviqSessionMemoryRuntimeState;
}

export interface ActoviqTaskToolInput {
  description: string;
  subagent_type?: string;
  run_in_background?: boolean;
}

export interface ActoviqTaskToolSyncResult {
  status: 'completed';
  subagentType: string;
  runId: string;
  sessionId?: string;
  model: string;
  text: string;
  toolCallCount: number;
}

export interface ActoviqTaskToolAsyncResult {
  status: 'async_launched';
  taskId: string;
  subagentType: string;
  sessionId?: string;
  outputFile: string;
  canReadOutputFile: boolean;
  description: string;
}

export type ActoviqTaskToolResult =
  | ActoviqTaskToolSyncResult
  | ActoviqTaskToolAsyncResult;

export interface ActoviqDelegatedAgentRecord {
  name: string;
  count: number;
  lastInvokedAt: string;
  lastDescription?: string;
}

export interface ActoviqAgentContinuityState {
  currentAgent?: string;
  delegatedAgents: ActoviqDelegatedAgentRecord[];
}

export type ActoviqBackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ActoviqBackgroundTaskRecord {
  id: string;
  status: ActoviqBackgroundTaskStatus;
  description: string;
  subagentType: string;
  outputFile: string;
  workDir: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  parentRunId?: string;
  parentSessionId?: string;
  sessionId?: string;
  runId?: string;
  model?: string;
  text?: string;
  toolCallCount?: number;
  error?: string;
}

export interface ActoviqMailboxMessage {
  id: string;
  teamName: string;
  to: string;
  from: string;
  kind: 'status' | 'task' | 'user';
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ActoviqTeammateRecord {
  id: string;
  teamName: string;
  name: string;
  agentName: string;
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  leaderName?: string;
  parentSessionId?: string;
  originPrompt?: string;
  lineage?: string[];
  taskId?: string;
  lastTaskDescription?: string;
  lastTaskStatus?: ActoviqBackgroundTaskStatus;
  lastRunId?: string;
  lastCompletedAt?: string;
  lastActiveAt?: string;
  lastResumedAt?: string;
  mailboxDepth?: number;
  mailboxMessageCount?: number;
  mailboxTurns?: number;
  lastMailboxMessageId?: string;
  runCount?: number;
  backgroundRunCount?: number;
  recoveryCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActoviqTeammateOptions {
  name: string;
  agent: string;
  prompt: string;
}

export interface CreateActoviqSwarmOptions {
  name: string;
  leader?: string;
  continuous?: boolean;
}

export interface ActoviqSwarmRunResult {
  teammate: ActoviqTeammateRecord;
  task?: ActoviqBackgroundTaskRecord;
  result?: AgentRunResult;
  source?: 'prompt' | 'mailbox' | 'background';
  mailboxMessagesProcessed?: number;
}

export interface ActoviqComputerUseExecutor {
  openUrl(url: string): Promise<void> | void;
  focusWindow?(title: string): Promise<void> | void;
  typeText(text: string): Promise<void> | void;
  keyPress(keys: string[]): Promise<void> | void;
  readClipboard(): Promise<string> | string;
  writeClipboard(text: string): Promise<void> | void;
  takeScreenshot(outputPath: string): Promise<string> | string;
}

export interface CreateActoviqComputerUseOptions {
  prefix?: string;
  executor?: ActoviqComputerUseExecutor;
  asMcpServer?: boolean;
  serverName?: string;
}

export interface WaitForActoviqBackgroundTaskOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
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
      type: 'tool.permission';
      runId: string;
      iteration: number;
      decision: ActoviqPermissionDecision;
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
      type: 'session.compacted';
      runId: string;
      sessionId: string;
      trigger: ActoviqCompactTrigger;
      result: ActoviqSessionCompactResult;
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
  messageCountSinceLastExtraction?: number;
  toolCallsSinceLastUpdate?: number;
  initialized: boolean;
  meetsInitializationThreshold?: boolean;
  meetsUpdateThreshold?: boolean;
  meetsToolCallThreshold?: boolean;
  hasToolCallsInLastTurn?: boolean;
  shouldExtract?: boolean;
}

export interface ActoviqSessionMemoryRuntimeState {
  initialized: boolean;
  tokensAtLastExtraction: number;
  lastMessageCountAtExtraction: number;
  lastSummarizedMessageCount?: number;
  extractionCount: number;
  lastExtractionAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  pendingPostCompaction: boolean;
}

export interface AgentSessionMemoryExtractionOptions {
  force?: boolean;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ActoviqSessionMemoryExtractionResult {
  success: boolean;
  skipped: boolean;
  updated: boolean;
  trigger: 'auto' | 'manual';
  reason?: string;
  sessionId?: string;
  memoryPath?: string;
  summary?: string;
  usage?: Usage;
  state: ActoviqSessionMemoryRuntimeState;
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
  hasToolCallsInLastTurn?: boolean;
  messageCountSinceLastExtraction?: number;
  toolCallsSinceLastUpdate?: number;
  runtimeState?: ActoviqSessionMemoryRuntimeState;
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
  runtimeState?: ActoviqSessionMemoryRuntimeState;
  agentContinuity?: ActoviqAgentContinuityState;
  invokedSkills?: ActoviqInvokedSkillRecord[];
  transcriptPath?: string;
  boundaries?: ActoviqTranscriptBoundary[];
  latestBoundary?: ActoviqTranscriptBoundary;
  compactCount: number;
  microcompactCount: number;
  hasCompacted: boolean;
  pendingPostCompaction?: boolean;
  lastSummarizedMessageUuid?: string;
  latestPreservedSegment?: ActoviqPreservedSegment;
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

export interface ActoviqPreservedSegment {
  headUuid: string;
  anchorUuid: string;
  tailUuid: string;
}

export interface ActoviqCompactBoundaryMetadata {
  trigger?: string;
  preTokens?: number;
  userContext?: string;
  messagesSummarized?: number;
  preservedMessages?: number;
  droppedMessages?: number;
  retryCount?: number;
  continuationDepth?: number;
  preservedSegment?: ActoviqPreservedSegment;
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





