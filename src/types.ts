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
  modelApi?: ModelApi;
  model?: string;
  provider?: string;
  effort?: ActoviqEffort;
}

export type ActoviqPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'auto';

export type ActoviqModelTier = 'min' | 'medium' | 'max';
export type ActoviqEffort = 'low' | 'medium' | 'high' | 'max';
export type ActoviqRunEffort = ActoviqEffort | 'auto';

export interface ActoviqModelTierConfig {
  min?: string;
  medium?: string;
  max?: string;
}

export type ActoviqPermissionBehavior = 'allow' | 'deny' | 'ask';

export interface ActoviqPermissionRule {
  toolName: string;
  behavior: ActoviqPermissionBehavior;
  matcher?: string;
  source?: string;
}

export interface ActoviqSessionPermissionState {
  mode?: ActoviqPermissionMode;
  permissions: ActoviqPermissionRule[];
}

export interface ActoviqPermissionDecision {
  toolName: string;
  publicName: string;
  behavior: 'allow' | 'deny';
  reason: string;
  source: 'mode' | 'rule' | 'classifier' | 'approver' | 'canUseTool';
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

export interface ActoviqCanUseToolContext {
  runId: string;
  sessionId?: string;
  workDir: string;
  toolName: string;
  publicName: string;
  input: unknown;
  prompt: string;
  iteration: number;
}

export type ActoviqCanUseToolResult =
  | { behavior: 'allow' | 'deny' | 'ask'; reason?: string }
  | void;

export type ActoviqCanUseTool = (
  context: ActoviqCanUseToolContext,
) => Promise<ActoviqCanUseToolResult> | ActoviqCanUseToolResult;

// ── Tool Progress ─────────────────────────────────────────────────

export interface ToolProgressData {
  type: string;
  [key: string]: unknown;
}

export interface ToolProgress<P extends ToolProgressData = ToolProgressData> {
  toolUseID: string;
  data: P;
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void;

// ── Tool Validation ───────────────────────────────────────────────

export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode?: number };

// ── Tool Prompt ───────────────────────────────────────────────────

export interface ToolPromptOptions {
  tools: string[];
  workDir: string;
  permissionMode?: ActoviqPermissionMode;
}

// ── Tool Definition ───────────────────────────────────────────────

export interface CreateToolOptions<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  serialize?: (output: Output) => string | ToolResultBlockParam['content'];
  strict?: boolean;
  examples?: Array<Record<string, unknown>>;
  isReadOnly?: (input?: Input) => boolean;
  isDestructive?: (input?: Input) => boolean;
  requiresUserInteraction?: () => boolean;
  isConcurrencySafe?: () => boolean;
  checkPermissions?: (
    context: { mode: ActoviqPermissionMode; runId: string; sessionId?: string },
  ) => Promise<'allow' | 'deny' | 'ask' | void> | 'allow' | 'deny' | 'ask' | void;
  /** Alternative names for backwards compatibility when a tool is renamed. */
  aliases?: string[];
  /** Human-readable display name shown in the UI. Defaults to name. */
  userFacingName?: (input?: Input) => string;
  /** One-line capability phrase (3-10 words) for tool search keyword matching. */
  searchHint?: string;
  /** Behavior when a new user message arrives during tool execution. Defaults to 'block'. */
  interruptBehavior?: 'cancel' | 'block';
  /** Whether the non-verbose rendering is truncated (gates expand affordance). */
  isResultTruncated?: (output: Output) => boolean;
  /** Maximum size in characters before result is persisted to disk. Defaults to 50000. */
  maxResultSizeChars?: number;
  /** Whether two inputs are equivalent (for dedup). */
  inputsEquivalent?: (a: Input, b: Input) => boolean;
  /** Pre-flight validation — determines if the tool is allowed to run with this input. */
  validateInput?: (input: Input, context: ToolExecutionContext) => Promise<ValidationResult> | ValidationResult;
  /** Compact summary for the tool invocation in collapsed views. */
  getToolUseSummary?: (input: Input) => string;
  /** System prompt text teaching the model how to use this tool. */
  prompt?: (options: ToolPromptOptions) => Promise<string> | string;
}

export interface AgentToolDefinition<Input = any, Output = any> {
  kind: 'local';
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  inputJsonSchema: Record<string, unknown>;
  serialize?: (output: Output) => string | ToolResultBlockParam['content'];
  execute: (
    input: Input,
    context: ToolExecutionContext,
    onProgress?: ToolCallProgress,
  ) => Promise<Output> | Output;
  strict?: boolean;
  examples?: Array<Record<string, unknown>>;
  isReadOnly?: (input?: Input) => boolean;
  isDestructive?: (input?: Input) => boolean;
  requiresUserInteraction?: () => boolean;
  isConcurrencySafe?: () => boolean;
  checkPermissions?: (
    context: { mode: ActoviqPermissionMode; runId: string; sessionId?: string },
  ) => Promise<'allow' | 'deny' | 'ask' | void> | 'allow' | 'deny' | 'ask' | void;
  aliases?: string[];
  userFacingName?: (input?: Input) => string;
  searchHint?: string;
  interruptBehavior?: 'cancel' | 'block';
  isResultTruncated?: (output: Output) => boolean;
  maxResultSizeChars?: number;
  inputsEquivalent?: (a: Input, b: Input) => boolean;
  validateInput?: (input: Input, context: ToolExecutionContext) => Promise<ValidationResult> | ValidationResult;
  getToolUseSummary?: (input: Input) => string;
  prompt?: (options: ToolPromptOptions) => Promise<string> | string;
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
  extra_tool_schemas?: Record<string, unknown>[];
  effort?: ActoviqEffort;
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
  execute: (input: unknown, context: ToolExecutionContext, onProgress?: ToolCallProgress) => Promise<ResolvedToolExecutionResult>;
  isReadOnly?: (input?: unknown) => boolean;
  isDestructive?: (input?: unknown) => boolean;
  requiresUserInteraction?: () => boolean;
  isConcurrencySafe?: () => boolean;
  /** Per-tool result size cap in chars before artifacting to disk. */
  maxResultSizeChars?: number;
  checkPermissions?: (
    context: { mode: ActoviqPermissionMode; runId: string; sessionId?: string },
  ) => Promise<'allow' | 'deny' | 'ask' | void> | 'allow' | 'deny' | 'ask' | void;
}

export interface ResolvedRuntimeConfig {
  homeDir: string;
  loadedConfigPath?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model: string;
  modelTier?: ActoviqModelTier;
  modelTiers: ActoviqModelTierConfig;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  maxRetries: number;
  workDir: string;
  sessionDirectory: string;
  clientName: string;
  clientVersion: string;
  systemPrompt?: string;
  /** ReAct loop turn cap. Defaults to Infinity (no cap) like Claude Code's main agent. */
  maxToolIterations: number;
  /** Model switched to after repeated overload/rate-limit failures. */
  fallbackModel?: string;
  /** Add a prompt-cache breakpoint to Anthropic requests. Defaults to true. */
  promptCachingEnabled: boolean;
  userId?: string;
  metadata: Record<string, unknown>;
  compact: ActoviqCompactConfig;
  provider: 'anthropic' | 'openai';
  effort?: ActoviqEffort;
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

export interface ActoviqStopHookContext {
  runId: string;
  sessionId?: string;
  messages: MessageParam[];
  assistantMessage: Message;
  systemPrompt?: string;
  stopHookActive: boolean;
}

export interface ActoviqHookBlockingError {
  command?: string;
  reason: string;
}

export interface ActoviqStopHookResult {
  preventContinuation?: boolean;
  stopReason?: string;
  blockingErrors?: Array<string | ActoviqHookBlockingError>;
  nonBlockingErrors?: Array<string | ActoviqHookBlockingError>;
}

export type ActoviqStopHook = (
  context: ActoviqStopHookContext,
) => Promise<ActoviqStopHookResult | void> | ActoviqStopHookResult | void;

export interface ActoviqHooks {
  sessionStart?: ActoviqSessionStartHook[];
  postSampling?: ActoviqPostSamplingHook[];
  postRun?: ActoviqPostRunHook[];
  stopHooks?: ActoviqStopHook[];
}

export interface ActoviqAgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  effort?: ActoviqRunEffort;
  permissionMode?: ActoviqPermissionMode;
  maxToolIterations?: number;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  hooks?: ActoviqHooks;
  tools?: AgentToolDefinition[];
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedAgents?: string[];
  skills?: string[];
  mcpServers?: AgentMcpServerDefinition[];
  requiredMcpServers?: string[];
  inheritDefaultTools?: boolean;
  inheritDefaultMcpServers?: boolean;
  initialPrompt?: string;
  memory?: 'user' | 'project' | 'local';
  background?: boolean;
  isolation?: 'worktree';
  cwd?: string;
  allowNestedAgents?: boolean;
  source?: 'built-in' | 'user' | 'project' | 'custom';
  sourcePath?: string;
}

export interface ActoviqAgentDefinitionSummary {
  name: string;
  description: string;
  model?: string;
  effort?: ActoviqRunEffort;
  permissionMode?: ActoviqPermissionMode;
  maxToolIterations?: number;
  maxTurns?: number;
  toolNames: string[];
  allowedTools: string[];
  disallowedTools: string[];
  allowedAgents: string[];
  skills: string[];
  mcpServerNames: string[];
  requiredMcpServers: string[];
  inheritDefaultTools: boolean;
  inheritDefaultMcpServers: boolean;
  background: boolean;
  isolation?: 'worktree';
  memory?: 'user' | 'project' | 'local';
  source?: 'built-in' | 'user' | 'project' | 'custom';
  sourcePath?: string;
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
  effort?: ActoviqEffort;
  /** Optional version string from frontmatter (display/telemetry only). */
  version?: string;
  /** Friendly display label from frontmatter `name:`; the invocation name still comes from the directory. */
  displayName?: string;
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
  effort?: ActoviqEffort;
  version?: string;
  displayName?: string;
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

export type ActoviqCleanToolCategory =
  | 'file'
  | 'task'
  | 'computer'
  | 'mcp'
  | 'custom';

export interface ActoviqCleanToolMetadata {
  name: string;
  description: string;
  provider: 'local' | 'mcp';
  category: ActoviqCleanToolCategory;
  server?: string;
  strict: boolean;
  readOnly: boolean;
  mutating: boolean;
  examples?: Array<Record<string, unknown>>;
}

export interface ActoviqCleanToolCatalog {
  tools: ActoviqCleanToolMetadata[];
  byCategory: Record<ActoviqCleanToolCategory, ActoviqCleanToolMetadata[]>;
}

export interface ActoviqCleanToolLookupOptions {
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
}

export type ActoviqCleanSlashCommandName =
  | 'context'
  | 'compact'
  | 'memory'
  | 'dream'
  | 'tools'
  | 'skills'
  | 'agents';

export interface ActoviqCleanSlashCommandMetadata {
  name: ActoviqCleanSlashCommandName;
  helper:
    | 'context.overview'
    | 'context.compact'
    | 'context.memoryState'
    | 'context.dream'
    | 'context.tools'
    | 'context.skills'
    | 'context.agents';
  description: string;
}

export interface ActoviqCleanContextOverviewOptions {
  sessionId?: string;
  includeMemory?: boolean;
  includeCompactState?: boolean;
  includeTools?: boolean;
  includeSkills?: boolean;
  includeAgents?: boolean;
  toolLookup?: ActoviqCleanToolLookupOptions;
}

export interface ActoviqCleanContextOverview {
  sessionId?: string;
  tools: ActoviqCleanToolMetadata[];
  skills: ActoviqSkillDefinitionSummary[];
  agents: ActoviqAgentDefinitionSummary[];
  memoryState?: ActoviqMemoryState;
  compactState?: ActoviqCompactState;
}

export interface ActoviqRunSlashCommandOptions {
  sessionId?: string;
  args?: string;
  compact?: AgentSessionCompactOptions;
  dream?: ActoviqDreamRunOptions;
  memory?: Omit<ActoviqMemoryStateOptions, 'projectPath' | 'sessionId'>;
  overview?: ActoviqCleanContextOverviewOptions;
  toolLookup?: ActoviqCleanToolLookupOptions;
}

export interface ActoviqRunSlashCommandResult {
  name: ActoviqCleanSlashCommandName;
  text: string;
  data:
    | ActoviqCleanContextOverview
    | ActoviqSessionCompactResult
    | ActoviqMemoryState
    | ActoviqDreamRunResult
    | ActoviqCleanToolMetadata[]
    | ActoviqSkillDefinitionSummary[]
    | ActoviqAgentDefinitionSummary[];
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
  /** A full model ID or one of the configured min/medium/max tiers. */
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
  /** Optional ReAct loop turn cap. Unset means unlimited. */
  maxToolIterations?: number;
  fallbackModel?: string;
  promptCachingEnabled?: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  agents?: ActoviqAgentDefinition[];
  agentDirectories?: string[];
  loadDefaultAgentDirectories?: boolean;
  disableDefaultAgents?: boolean;
  maxSubagentDepth?: number;
  maxSubagentFanout?: number;
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
  provider?: 'anthropic' | 'openai';
  effort?: ActoviqEffort;
  modelApi?: ModelApi;
  sessionManager?: SessionManagerConfig;
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
  apiMicrocompactMaxRequestBytes?: number;
  apiMicrocompactClearToolResults?: boolean;
  apiMicrocompactClearToolUses?: boolean;
  toolResultArtifactMaxChars?: number;
  /**
   * Aggregate budget for all tool_result blocks produced in one iteration
   * (one user message). Largest results are artifacted to disk until the
   * batch fits. Mirrors Claude Code's per-message tool result budget.
   */
  toolResultsPerMessageMaxChars?: number;
  /**
   * In-loop auto-compact: summarize old conversation turns mid-run when the
   * estimated input tokens approach the model context window. Mirrors
   * Claude Code's per-iteration autocompact. Defaults to true.
   */
  loopAutoCompactEnabled?: boolean;
  /** Model context window in tokens used to derive the in-loop compact threshold. */
  contextWindowTokens?: number;
  /** Explicit in-loop compact trigger in estimated tokens. Overrides the derived threshold. */
  loopAutoCompactThresholdTokens?: number;
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
  /** Override the model client for this run — used by the /model router for cross-provider routing. */
  modelApi?: CreateAgentSdkOptions['modelApi'];
  maxTokens?: number;
  temperature?: number;
  toolChoice?: ToolChoice;
  userId?: string;
  metadata?: Record<string, unknown>;
  effort?: ActoviqRunEffort;
  hooks?: ActoviqHooks;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
  canUseTool?: ActoviqCanUseTool;
  signal?: AbortSignal;
  /**
   * Mid-run steering: called between tool iterations to collect user messages
   * queued while the agent was working. Drained texts are appended to the
   * next tool-result user message so the model sees them on its next request.
   */
  drainQueuedInputs?: () => string[];
  /** Override the runtime working directory for this run. */
  workDir?: string;
  /** When parent is in a worktree, inherit the worktree directory. Default: true. */
  inheritWorktree?: boolean;
  /** Override the working directory at the session level (used by worktrees). */
  sessionWorkDir?: string;
}

export interface SessionCreateOptions {
  id?: string;
  title?: string;
  systemPrompt?: string;
  model?: string;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  initialMessages?: MessageParam[];
}

export interface SessionForkOptions {
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SessionResumeOptions {
  /** Resume into a new session while preserving the source transcript and runtime state. */
  fork?: boolean;
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** A full model ID or configured min/medium/max tier. */
  model?: string;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
}

export interface AgentRequestSummary {
  iteration: number;
  messageId: string;
  model: string;
  stopReason: StopReason | null;
  usage?: Usage;
  text: string;
  createdAt: string;
  requestTokenEstimate?: number;
  requestByteLength?: number;
  localMicrocompact?: {
    enabled: boolean;
    clearedToolResults: number;
    tokenEstimateBefore: number;
    tokenEstimateAfter: number;
    requestByteLengthBefore?: number;
    requestByteLengthAfter?: number;
  };
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
  incompleteReason?: string;
  maxToolIterationsExceeded?: boolean;
  hookStopReason?: string;
  usage?: Usage;
  requests: AgentRequestSummary[];
  toolCalls: AgentToolCallRecord[];
  startedAt: string;
  completedAt: string;
  sessionHookMetadata?: Record<string, unknown>;
  delegatedAgents?: ActoviqDelegatedAgentRecord[];
  invokedSkills?: ActoviqInvokedSkillRecord[];
  reactiveCompact?: ActoviqSessionCompactResult;
  /** Mid-run conversation compactions performed inside the tool loop. */
  loopCompactions?: AgentLoopCompactionRecord[];
  permissionDecisions?: ActoviqPermissionDecision[];
}

export interface AgentLoopCompactionRecord {
  trigger: 'auto' | 'reactive';
  iteration: number;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  messagesSummarized: number;
  preservedMessages: number;
  clearedToolResults: number;
  summary?: string;
}

export interface ActoviqDreamConfig {
  minHours: number;
  minSessions: number;
  scanIntervalMs: number;
}

export interface ActoviqDreamPaths {
  memoryDir: string;
  teamMemoryDir: string;
  memoryEntrypoint: string;
  teamMemoryEntrypoint: string;
  transcriptDir: string;
  lockPath: string;
}

export interface ActoviqDreamState {
  enabled: boolean;
  autoMemoryEnabled: boolean;
  config: ActoviqDreamConfig;
  paths: ActoviqDreamPaths;
  currentSessionId?: string;
  lastConsolidatedAtMs: number;
  lastConsolidatedAt?: string;
  hoursSinceLastConsolidated: number;
  sessionsSinceLastConsolidated: string[];
  lockHeld: boolean;
  canRun: boolean;
  blockedReason?: 'disabled' | 'time_gate' | 'session_gate' | 'locked' | 'scan_throttled';
}

export interface ActoviqDreamRunOptions {
  force?: boolean;
  background?: boolean;
  currentSessionId?: string;
  extraContext?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ActoviqDreamRunResult {
  success: boolean;
  skipped: boolean;
  trigger: 'manual' | 'auto';
  reason?: string;
  state: ActoviqDreamState;
  touchedSessions: string[];
  touchedFiles: string[];
  result?: AgentRunResult;
  task?: ActoviqBackgroundTaskRecord;
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
    | 'microcompact'
    | 'compacted'
    | 'failed'
    | 'circuit_breaker_open';
  tokenEstimateBefore: number;
  tokenEstimateAfter?: number;
  summaryMessage?: string;
  messagesRemoved?: number;
  compactCount: number;
  microcompactCount: number;
  consecutiveFailures?: number;
  error?: string;
  state: ActoviqSessionMemoryRuntimeState;
}

export interface ActoviqTaskToolInput {
  description?: string;
  prompt?: string;
  task?: string;
  subagent_type?: string;
  agent?: string;
  agent_type?: string;
  model?: string;
  run_in_background?: boolean;
  name?: string;
  isolation?: 'worktree';
  cwd?: string;
}

export interface ActoviqTaskToolSyncResult {
  status: 'completed';
  subagentType: string;
  runId: string;
  sessionId?: string;
  agentId?: string;
  model: string;
  text: string;
  toolCallCount: number;
  toolErrorCount: number;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface ActoviqTaskToolAsyncResult {
  status: 'async_launched';
  taskId: string;
  subagentType: string;
  sessionId?: string;
  agentId?: string;
  outputFile: string;
  canReadOutputFile: boolean;
  description: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export type ActoviqTaskToolResult =
  | ActoviqTaskToolSyncResult
  | ActoviqTaskToolAsyncResult;

export interface ActoviqDelegatedAgentRecord {
  name: string;
  count: number;
  lastInvokedAt: string;
  lastDescription?: string;
  lastRunId?: string;
  lastSessionId?: string;
  lastStatus?: 'completed' | 'async_launched' | 'failed' | 'cancelled';
  lastTaskId?: string;
  lastTextSummary?: string;
  runIds?: string[];
  sessionIds?: string[];
  taskIds?: string[];
  totalRequestCount?: number;
  totalToolCallCount?: number;
  totalToolErrorCount?: number;
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
  agentName?: string;
  sessionId?: string;
  runId?: string;
  model?: string;
  text?: string;
  partialText?: string;
  toolCallCount?: number;
  toolErrorCount?: number;
  requestCount?: number;
  currentIteration?: number;
  currentToolName?: string;
  progressSummary?: string;
  queuedMessageCount?: number;
  resumedFromTaskId?: string;
  notificationDeliveredAt?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  retainedWorktree?: boolean;
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

export interface ActoviqSwarmRuntimeContext {
  hooks?: ActoviqHooks;
  permissionMode?: ActoviqPermissionMode;
  permissions?: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
}

export interface ActoviqTeammateTranscript {
  teammate: ActoviqTeammateRecord;
  sessionId: string;
  messages: MessageParam[];
  leaderInbox: ActoviqMailboxMessage[];
  teammateInbox: ActoviqMailboxMessage[];
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
      requestTokenEstimate?: number;
      requestByteLength?: number;
      localMicrocompact?: AgentRequestSummary['localMicrocompact'];
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
      type: 'tool.progress';
      runId: string;
      iteration: number;
      toolUseId: string;
      data: ToolProgressData;
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
      type: 'conversation.compacted';
      runId: string;
      iteration: number;
      /** 'auto' = proactive threshold compact; 'reactive' = provider rejected the request as too long. */
      trigger?: 'auto' | 'reactive';
      tokenEstimateBefore: number;
      tokenEstimateAfter: number;
      messagesSummarized: number;
      preservedMessages: number;
      clearedToolResults: number;
      timestamp: string;
    }
  | {
      type: 'model.fallback';
      runId: string;
      iteration: number;
      fromModel: string;
      toModel: string;
      reason: string;
      timestamp: string;
    }
  | {
      type: 'request.interrupted';
      runId: string;
      iteration: number;
      retry: number;
      maxRetries: number;
      reason: string;
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
    }
  | {
      type: 'workflow.start';
      runId: string;
      workflowName: string;
      stepCount: number;
      timestamp: string;
    }
  | {
      type: 'step.start';
      runId: string;
      workflowName: string;
      stepId: string;
      stepName: string;
      timestamp: string;
    }
  | {
      type: 'step.done';
      runId: string;
      workflowName: string;
      stepId: string;
      status: 'completed' | 'failed' | 'skipped';
      durationMs: number;
      timestamp: string;
    }
  | {
      type: 'workflow.done';
      runId: string;
      workflowName: string;
      status: 'completed' | 'partial' | 'failed';
      durationMs: number;
      timestamp: string;
      errors?: Array<{ stepId: string; error: string }>;
    }
  // ── v0.5.0 Dynamic Workflow events ────────────────────────────
  | {
      type: 'workflow.script.start';
      runId: string;
      workflowName: string;
      phases: WorkflowMeta['phases'];
      timestamp: string;
    }
  | {
      type: 'workflow.phase.start';
      runId: string;
      phase: string;
      timestamp: string;
    }
  | {
      type: 'workflow.agent.start';
      runId: string;
      agentId: string;
      label?: string;
      phase?: string;
      cached: boolean;
      timestamp: string;
    }
  | {
      type: 'workflow.agent.done';
      runId: string;
      agentId: string;
      phase?: string;
      cached: boolean;
      durationMs: number;
      tokens?: { input: number; output: number };
      error?: string;
      timestamp: string;
    }
  | {
      type: 'workflow.log';
      runId: string;
      message: string;
      timestamp: string;
    }
  | {
      type: 'workflow.script.done';
      runId: string;
      workflowName: string;
      status: 'completed' | 'failed' | 'stopped';
      durationMs: number;
      agentCount: number;
      totalTokens: number;
      errors?: WorkflowRunState['errors'];
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

export type SessionStatus = 'active' | 'idle' | 'closed';

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
  lastActiveAt?: string;
  status: SessionStatus;
  messages: MessageParam[];
  runs: StoredRunSummary[];
  // ── v0.5.0 worktree fields (+ 'manager' for project-manager sessions) ──
  kind?: 'main' | 'worktree' | 'manager';
  worktreePath?: string;
  worktreeBranch?: string;
  parentSessionId?: string;
  originalWorkDir?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  titleSource: 'auto' | 'manual';
  model: string;
  /** Last runtime used for this session (bridge config runtime or `hadamard`). */
  runtime: string;
  /** Last named provider config used; null when the default Hadamard provider ran. */
  configName: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastActiveAt?: string;
  status: SessionStatus;
  tags: string[];
  preview: string;
  messageCount: number;
  runCount: number;
  /** True when the session file lives in the project archive/ directory. */
  archived?: boolean;
  /** Session kind — 'manager' sessions belong to the Project Manager panel, not the chat list. */
  kind?: 'main' | 'worktree' | 'manager';
}

export interface SessionManagerConfig {
  /** Maximum stored sessions. When exceeded, the oldest idle/closed sessions are evicted during `touch()`. */
  maxSessions?: number;
  /** Mark session as idle after this many ms of inactivity. Default: 30 min. */
  idleTimeoutMs?: number;
  /** NOT YET ENFORCED — reserved for future use. */
  maxConcurrentActive?: number;
  /** Interval for auto-cleanup of closed sessions. Default: 5 min. */
  cleanupIntervalMs?: number;
}

export interface SessionStats {
  total: number;
  active: number;
  idle: number;
  closed: number;
}

export interface SessionPruneParams {
  olderThan?: string;
  status?: SessionStatus;
}

export interface ParallelOptions {
  maxConcurrency?: number;
  failFast?: boolean;
  signal?: AbortSignal;
}

export interface RaceOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SessionCheckpoint {
  id: string;
  label: string;
  sessionId: string;
  createdAt: string;
  snapshot: StoredSession;
}

export interface SessionCheckpointSummary {
  id: string;
  label: string;
  createdAt: string;
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

export interface AgentSessionDreamOptions extends ActoviqDreamRunOptions {}

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
  consecutiveCompactFailures?: number;
  lastCompactFailureAt?: string;
  lastCompactError?: string;
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

// ─── Scheduling ───────────────────────────────────────────────

export interface CronSchedule {
  /** 5-field cron expression: "minute hour dayOfMonth month dayOfWeek" */
  cron: string;
  /** IANA timezone (e.g. "Asia/Shanghai"). Omit for local timezone. */
  timezone?: string;
}

export interface ScheduledTaskDefinition<TOutput = unknown> {
  id: string;
  schedule: CronSchedule;
  task: (context: ScheduledTaskContext) => Promise<TOutput> | TOutput;
  description?: string;
  enabled?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface ScheduledTaskContext {
  taskId: string;
  scheduledAt: string;
  invocationCount: number;
  previousResult?: unknown;
}

export interface ScheduledTaskRecord {
  id: string;
  schedule: string;
  description?: string;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: 'success' | 'failure' | 'timeout';
  lastError?: string;
  nextRunAt: string;
  invocationCount: number;
  createdAt: string;
}

export interface ScheduledTaskStore {
  save(task: ScheduledTaskRecord): Promise<void>;
  load(id: string): Promise<ScheduledTaskRecord | undefined>;
  list(): Promise<ScheduledTaskRecord[]>;
  delete(id: string): Promise<void>;
}

export interface TaskSchedulerOptions {
  tickIntervalMs?: number;
  store?: ScheduledTaskStore;
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  defaultRetryDelayMs?: number;
}

export type ScheduledAutomationKind = 'workflow' | 'prompt' | 'manager';

/** How an automation task is fired. */
export type AutomationTriggerType = 'schedule' | 'webhook';

/**
 * A scheduled or webhook-triggered automation task. Schedule tasks fire on a
 * cron expression; webhook tasks fire when their unique webhook URL receives a
 * POST. Tasks are persisted per project workDir, or globally when `scope` is
 * 'global' (created from any conversation via /automation).
 */
export interface ScheduledAutomationTask {
  id: string;
  name: string;
  kind: ScheduledAutomationKind;
  /** Trigger type. Absent → 'schedule' (backward compat). */
  trigger?: AutomationTriggerType;
  /** Cron expression for trigger==='schedule'. Empty for webhook tasks. */
  cron: string;
  enabled: boolean;
  description?: string;
  workflowName?: string;
  input?: string;
  prompt?: string;
  /** Webhook: unique token in the webhook URL (trigger==='webhook'). */
  webhookId?: string;
  /** Webhook: shared secret verified via x-webhook-secret header. */
  webhookSecret?: string;
  /** Webhook: optional case-insensitive substring the request body must contain. */
  webhookFilter?: string;
  /** 'global' = created from conversation (any project); otherwise the project workDir path. */
  scope?: string;
  lastRunAt?: string;
  lastResult?: ScheduledTaskRecord['lastResult'];
  lastError?: string;
  /** ISO time of the next scheduled run (schedule trigger only). */
  nextRunAt: string;
  invocationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledAutomationTaskInput {
  id?: string;
  name?: string;
  kind?: ScheduledAutomationKind;
  trigger?: AutomationTriggerType;
  cron?: string;
  enabled?: boolean;
  description?: string;
  workflowName?: string;
  input?: string;
  prompt?: string;
  webhookId?: string;
  webhookSecret?: string;
  webhookFilter?: string;
  scope?: string;
}

// ═══════════════════════════════════════════════════════════════════════
//  Bridge SDK types — restored from f6d619a
// ═══════════════════════════════════════════════════════════════════════

export type ActoviqBridgePermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

export type ActoviqBridgeToolsOption = 'default' | 'none' | string[];

/**
 * Which agent CLI directCli mode drives. `claude` (default) uses Claude Code's
 * `-p` stream-json protocol; `pi` and `codex` reuse the same spawn + JSONL
 * pipeline with their own wire protocols.
 */
export type RuntimeProviderId = 'claude' | 'pi' | 'codex' | 'codewhale' | 'reasonix' | 'crush';

/** Result of `detectBridgeProviders()` — one entry per known provider. */
export interface BridgeProviderDetection {
  id: RuntimeProviderId;
  displayName: string;
  /** Resolved path (if found), `undefined` if not installed/configured. */
  path?: string;
  /** `true` when the executable was resolved successfully. */
  available: boolean;
  /** Best-effort `--version` string, or `undefined` if probing failed. */
  version?: string;
}

export interface ActoviqBridgeJsonEvent extends Record<string, unknown> {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
}

export interface CreateActoviqBridgeSdkOptions {
  executable?: string;
  cliPath?: string;
  /**
   * Spawn a locally installed agent CLI directly, bypassing the vendored
   * `runtime.bundle.br` + Bun wrapper. When true, `executable` is the CLI to
   * spawn (defaults to the provider's binary on PATH). Provider isolation
   * (env injection) applies to all providers.
   */
  directCli?: boolean;
  /**
   * Which agent CLI directCli mode drives. Defaults to `claude` (Claude Code
   * `-p` stream-json). `pi` and `codex` reuse the same spawn + JSONL pipeline
   * but speak their own wire protocols — see `src/parity/bridgeProviders.ts`.
   * Only consulted when `directCli` is true; ignored by the bundle path.
   */
  directCliProvider?: RuntimeProviderId;
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

export type ActoviqCleanBridgeParityStatus =
  | 'exact'
  | 'mapped'
  | 'simulated'
  | 'unsupported';

export interface ActoviqCleanBridgeParityMatrixEntry {
  option: keyof ActoviqBridgeRunOptions | keyof CreateActoviqBridgeSdkOptions;
  status: ActoviqCleanBridgeParityStatus;
  cleanTarget?: string;
  notes: string;
}

export interface ActoviqCleanBridgeUnsupportedOption {
  option: string;
  value: unknown;
  reason: string;
}

export interface ActoviqCleanBridgeCompatibilityReport {
  mapped: Array<{
    option: string;
    cleanTarget: string;
    status: Exclude<ActoviqCleanBridgeParityStatus, 'unsupported'>;
    note?: string;
  }>;
  unsupported: ActoviqCleanBridgeUnsupportedOption[];
}

export type ActoviqCleanBridgeUnsupportedOptionPolicy = 'metadata' | 'warn' | 'throw';

export interface CreateActoviqCleanBridgeSdkOptions extends CreateAgentSdkOptions {
  bridgeDefaults?: CreateActoviqBridgeSdkOptions;
  unsupportedOptionPolicy?: ActoviqCleanBridgeUnsupportedOptionPolicy;
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

// ═══════════════════════════════════════════════════════════════════════
//  v0.5.0: Dynamic Workflows types
// ═══════════════════════════════════════════════════════════════════════

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
  whenToUse?: string;
}

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  isolation?: 'worktree';
  agentType?: string;
  tools?: string[];
}

export interface WorkflowBudget {
  total: number | null;
  spent: () => number;
  remaining: () => number;
}

export interface WorkflowScriptContext {
  agent: (prompt: string, opts?: WorkflowAgentOptions) => Promise<any>;
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
  pipeline: <T, R>(
    items: T[],
    ...stages: Array<(prev: any, item: T, index: number) => Promise<R | null>>
  ) => Promise<(R | null)[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  budget: WorkflowBudget;
  args: any;
  meta: WorkflowMeta;
}

export interface WorkflowAgentCallRecord {
  id: string;
  prompt: string;
  opts: WorkflowAgentOptions;
  phase?: string;
  result?: unknown;
  error?: string;
  tokens?: { input: number; output: number };
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
  cached: boolean;
}

export interface WorkflowPhaseProgress {
  title: string;
  agentCount: number;
  completedCount: number;
  failedCount: number;
  totalTokens: number;
  startedAt: string;
  completedAt?: string;
}

export interface WorkflowRunState {
  runId: string;
  meta: WorkflowMeta;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  phases: WorkflowPhaseProgress[];
  agentCalls: WorkflowAgentCallRecord[];
  errors: Array<{ agentId: string; phase?: string; error: string; itemIndex?: number; stageIndex?: number }>;
  startedAt: string;
  completedAt?: string;
  totalTokens: number;
  estimatedCost: number | null;
}

export interface WorkflowCacheEntry {
  key: string;
  result: unknown;
  tokens?: { input: number; output: number };
  durationMs: number;
  cachedAt: string;
}

export interface WorkflowResumeState {
  runId: string;
  cache: Map<string, WorkflowCacheEntry>;
  agentCallIds: string[];
  completedAgentIds: Set<string>;
  phases: WorkflowPhaseProgress[];
  errors: WorkflowRunState['errors'];
}

// ═══════════════════════════════════════════════════════════════════════
//  v0.5.0: Worktree types
// ═══════════════════════════════════════════════════════════════════════

export interface WorktreeStackEntry {
  workDir: string;
  worktreePath?: string;
  worktreeBranch?: string;
  sessionKind: 'main' | 'worktree';
}

export interface WorktreeSessionFields {
  kind: 'main' | 'worktree';
  worktreePath?: string;
  worktreeBranch?: string;
  parentSessionId?: string;
  originalWorkDir: string;
}

export interface WorktreeSettings {
  baseRef: 'fresh' | 'head';
  cleanupPeriodDays: number;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  ref?: string;
  pr?: string;
  createdAt: string;
  isDirty: boolean;
  sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
//  v0.5.0: Model Team types
// ═══════════════════════════════════════════════════════════════════════

/**
 * `panel-analysis` is the unified expert-panel mode: read-only ReAct members
 * (the `analysis` foundation) with optional primary-driven multi-round
 * convergence (the `panel` capability). `panel` and `analysis` are retained as
 * backward-compatible aliases that route to the same engine.
 */
export type ModelTeamMode = 'panel-analysis' | 'panel' | 'analysis' | 'reviewer' | 'executor-reviewer' | 'graph';

/** A node in a workflow squad's execution tree. */
export interface WorkflowNode {
  id: string;
  /** Agent = run a prompt; branch = if/else split (children[0]=true, children[1]=false); parallel = run all children concurrently. */
  type: 'agent' | 'branch' | 'parallel';
  label?: string;
  /** Agent nodes: the prompt to run. */
  prompt?: string;
  /** Branch nodes: case-insensitive substring the upstream output must contain to take the `true` child. */
  condition?: string;
  runtime?: string;
  model?: string;
  /** Children: branch=[if,else], parallel=all, agent=[] (leaf). */
  children: WorkflowNode[];
}

export interface TeamMember {
  model: string;
  provider?: 'anthropic' | 'openai';
  baseURL?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxTokens?: number;
  description?: string;
  /** Stable identity used in reports/events/status. Falls back to name → role → model. */
  id?: string;
  /** Human-readable name (e.g. "researcher"); used for labels when `id` is absent. */
  name?: string;
  /** The member's role/specialty (e.g. "security", "skeptic"). */
  role?: string;
  /** User-facing task ownership for this member inside a team run. */
  responsibility?: string;
  /** Member ids/names/roles this member should review after they work. */
  reviews?: string[];
  /** Member ids/names/roles this member depends on before it should work. */
  dependsOn?: string[];
  /** Preferred local/runtime label for this member, if it should use a named runtime. */
  runtime?: string;
  /** Tool families this member is expected to use, shown in GUI planning surfaces. */
  toolScope?: string[];
  /**
   * Workspace access for this member during a team run.
   * `workspace` (default): project workspace only.
   * `full`: unrestricted filesystem access (same as the main agent).
   */
  workspaceAccess?: 'workspace' | 'full';
}

export interface TeamReviewEdge {
  /** Reviewer member id/name/role. */
  from: string;
  /** Reviewed member id/name/role. */
  to: string;
  kind?: 'review' | 'handoff' | 'support';
  note?: string;
}

// ── Graph orchestration (TeamDefinition version 2+) ────────────────────

/** How an edge wakes its downstream node. v1 engine auto-schedules only `on_complete`. */
export type TeamGraphTrigger = 'on_complete' | 'on_tool_call' | 'on_handoff' | 'on_review_request' | 'manual';

/** What kind of communication the edge carries (labeling/UI semantics). */
export type TeamGraphChannel = 'message' | 'handoff' | 'review' | 'broadcast';

/** v3 port + agent nodes on the collaboration canvas. */
export type TeamGraphNodeKind = 'task' | 'agent' | 'return';

/** How a Return port delivers its result to the team caller. */
export type TeamGraphReturnMode = 'void' | 'payload';

/**
 * A graph node is a team member plus graph-only fields. Nodes are read-only by
 * default (same expert toolset as panel members); `allowedTools` opts specific
 * core tools in per node — granting Write/Bash requires an explicit editor
 * confirmation (product rule, enforced at the UI layer).
 *
 * v3: `kind: 'task'` (exactly one per graph) dispatches `run.prompt`; `kind:
 * 'return'` (≥1) terminates the run. Absent `kind` → `agent` (v2 compat).
 */
export interface TeamGraphNode extends Omit<TeamMember, 'model'> {
  /** Agent nodes require a model; task/return ports omit it. */
  model?: string;
  /** v3 node kind. Default `agent`. */
  kind?: TeamGraphNodeKind;
  /**
   * Execution mode for agent nodes.
   * - `react` (default): full ReAct loop with the node's allowed tools.
   * - `single`: one LLM call, no tools — answer directly.
   * - `team`: invoke another persisted team definition by `teamRef` as a
   *   sub-agent; the sub-team's answer becomes this node's output.
   */
  type?: 'react' | 'single' | 'team';
  /** When `type === 'team'`, name of the persisted team definition to invoke. */
  teamRef?: string;
  /** Return ports only — `void` (return 0) or structured `payload`. */
  returnMode?: TeamGraphReturnMode;
  /** Return ports in `payload` mode — template for the structured return value. */
  payloadTemplate?: string;
  /** v2 entry flag — migrated to Task→agent edges in v3. */
  entry?: boolean;
  /** Core-tool whitelist for this node. Absent → read-only expert tools. */
  allowedTools?: string[];
  /**
   * Join semantics across this node's `on_complete` in-edges.
   * `all` (default): wait-all — wake once after every in-edge resolves.
   * `any`: OR-join — wake on the first in-edge that delivers a payload.
   */
  join?: 'all' | 'any';
  /** GUI canvas position (pixels). Ignored by the graph engine. */
  ui?: { x?: number; y?: number };
  /** Per-node ReAct tool-iteration cap. Omit or ≤0 = unlimited. */
  maxIterations?: number;
  /** Per-node run timeout (ms). Omit → squad default. */
  timeoutMs?: number;
  /** Transient network-error reconnect attempts. Default 10. */
  reconnectAttempts?: number;
  /** Per-node graph loop-round cap. Omit or ≤0 = unlimited (squad `maxRounds` applies). */
  maxRounds?: number;
}

export interface TeamGraphEdge {
  /** Upstream node ref (id → name → role → model). */
  from: string;
  /** Downstream node ref. */
  to: string;
  channel?: TeamGraphChannel;
  /** Default: `on_complete`. */
  trigger?: TeamGraphTrigger;
  /**
   * Template for the payload delivered downstream. Supports `{{from.output}}`,
   * `{{from.id}}`, and `{{run.prompt}}` placeholders. Absent → a labeled
   * "input from <id>" section containing the upstream report.
   */
  payloadTemplate?: string;
  /**
   * Output gate: the edge fires only when the upstream output matches.
   * `/pattern/` (optionally `/pattern/i`) is a regex test; anything else is a
   * case-sensitive substring test. A gated-out edge releases its join slot
   * without a payload; a node whose every in-edge gates out is skipped
   * (conditional short-circuit) and releases its own downstream edges.
   */
  condition?: string;
  note?: string;
  /** v3: back-edge for convergence loops — requires `maxRounds` on the definition. */
  loop?: boolean;
  /**
   * Edge direction for GUI + runtime. Default / omitted = `directed` (from → to).
   * `undirected` (↔): bidirectional — runtime expands a reverse sibling for
   * communication triggers; passive `on_complete` edges still store one record
   * but also gain reverse scheduling except when `loop` is set.
   */
  direction?: 'directed' | 'undirected';
  /**
   * GUI canvas cubic-bezier control points (offsets from from/to ports).
   * Ignored by the graph engine; persisted with the squad JSON on Save.
   */
  ui?: {
    c1?: { dx: number; dy: number };
    c2?: { dx: number; dy: number };
    /**
     * GUI-only snap-point index on the source/target node's edge (0-based).
     * Agents have 3 snaps per side (0=left, 1=center, 2=right); task/return have
     * 1 (index 0). Default/absent → center. Ignored by the graph engine.
     */
    fromPort?: number;
    toPort?: number;
  };
}

export interface TeamDefinition {
  name: string;
  description?: string;
  mode: ModelTeamMode;
  /** Definition schema version. Missing → 1. Version 2 adds graph orchestration. */
  version?: number;
  /** How the team executes. Version 2 only; v1 definitions are implicitly `legacy-mode`. */
  orchestration?: 'legacy-mode' | 'graph';
  /**
   * Squad kind — drives which editor the GUI shows. Absent → 'graph' (back-compat).
   * - `graph`: collaboration graph (Task → agents → Return), the existing editor.
   * - `workflow`: linear/tree work-flow node editor (Phase 3 — visual work tree).
   * - `subagent`: a single configured agent (prompt + tools + workspace + runtime).
   */
  squadType?: 'graph' | 'workflow' | 'subagent';
  /** Workflow squad only: the execution tree. */
  workflowTree?: WorkflowNode;
  /** Panel members (panel-analysis / its `panel`+`analysis` aliases). */
  members: TeamMember[];
  /** Optional synthesizer that drives panel-analysis convergence. */
  primary?: TeamMember;
  /** The reviewer model (reviewer / its `executor-reviewer` alias). */
  reviewer?: TeamMember;
  /**
   * Explicit collaboration edges used by GUI/team planners (v1 only). The
   * v1 → v2 migrator converts these into `edges` with `channel: 'review'` and
   * drops the field — it is not carried forward on graph definitions.
   */
  reviewEdges?: TeamReviewEdge[];
  /** Graph nodes (mode `graph`, version 2). */
  nodes?: TeamGraphNode[];
  /** Graph edges (mode `graph`, version 2). */
  edges?: TeamGraphEdge[];
  /** Entry node refs; alternative to per-node `entry: true` (union of both applies). */
  entryNodeIds?: string[];
  /** Max panel members dispatched concurrently within this team (still bounded by the global AgentPool). Default: all members. */
  maxParallel?: number;
  /** Per-member, per-call timeout in ms. */
  timeoutMs?: number;
  /** Safety cap on panel-analysis convergence rounds. Default 100; raise/lower per cost budget. */
  maxRounds?: number;
  /** Per-member ReAct tool-iteration cap for panel-analysis/reviewer members. Default 16. */
  maxIterations?: number;
}

export interface TeamCost {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number | null;
  breakdown: Array<{ model: string; cost: number }>;
  costWarning?: boolean;
}

/** Per-member execution outcome, collected centrally by the team runtime. */
export interface MemberStatus {
  /** Stable member identity (disambiguates members that share a model). */
  id: string;
  model: string;
  role?: string;
  ok: boolean;
  error?: string;
  toolCalls?: number;
  durationMs?: number;
  /** True when the member never ran (e.g. preflight failed: missing API key). */
  skipped?: boolean;
}

/** Progress events emitted while a team deliberates (for TUI/GUI/programmatic observers). */
export type TeamEvent =
  | { type: 'team.started'; mode: ModelTeamMode; members: Array<{ id: string; model: string; role?: string }> }
  | { type: 'team.member.started'; id: string; model: string; role?: string; round: number }
  | { type: 'team.member.tool'; id: string; model: string; round: number; tool: string }
  | { type: 'team.member.completed'; id: string; model: string; role?: string; round: number; ok: boolean; toolCalls: number; durationMs: number; error?: string }
  | { type: 'team.round.completed'; round: number; reports: number }
  | { type: 'team.synthesis'; round: number; decision: 'finalize' | 'continue' }
  | { type: 'team.edge.triggered'; from: string; to: string; trigger: TeamGraphTrigger; channel: TeamGraphChannel }
  | { type: 'team.returned'; nodeId: string; returnMode: TeamGraphReturnMode; returnValue?: string }
  | { type: 'team.completed'; mode: ModelTeamMode; rounds: number; incompleteReason?: string };

/** Options for `ModelTeam.ask`. */
export interface TeamAskOptions {
  /** Reviewer-mode only: what the requesting agent did and obtained (injected into the reviewer prompt). */
  context?: string;
  /** Working directory the team members operate over. */
  workDir?: string;
  /** Receives progress events as the team deliberates. */
  onEvent?: (event: TeamEvent) => void;
  /**
   * Internal recursion guard for `type: 'team'` graph nodes: the chain of team
   * refs currently being executed. The top-level call omits this; each team node
   * appends its own ref before invoking the sub-team.
   */
  teamStack?: string[];
}

export interface TeamResult {
  answer: string;
  mode: ModelTeamMode;
  cost: TeamCost;
  durationMs: number;
  /** Per-member execution status (includes failures and preflight skips). */
  memberStatuses?: MemberStatus[];
  /** Set when the run did not fully succeed (e.g. some members failed, or the round cap was hit). */
  incompleteReason?: string;
}

/**
 * One panel/graph agent's findings report.
 */
export interface ExpertPanelReport {
  model: string;
  /** Stable member identity (disambiguates members that share a model). */
  id?: string;
  /** Member role/specialty, if configured. */
  role?: string;
  report: string;
  toolCalls: number;
  durationMs: number;
  /** Investigation round (1-based); >1 only in convergent panel-analysis. */
  round?: number;
}

/**
 * `graph` mode result: all team runs return this shape (graph v3 runtime).
 * Legacy `reviewer` / `panel-analysis` inputs are migrated before execution.
 */
export interface GraphTeamResult extends TeamResult {
  mode: 'graph';
  reports: ExpertPanelReport[];
  /** Node ids that never ran (unreachable, or only manual/communication in-edges). */
  skippedNodes: string[];
  /** v3: null = void / natural convergence (return 0). */
  returnValue?: string | null;
  returnMode?: TeamGraphReturnMode;
  returnNodeId?: string;
  /** Convergence loop rounds (v3 graphs with loop edges). */
  graphRounds?: number;
}

/** @deprecated Runtime always returns {@link GraphTeamResult}. Kept for type compatibility. */
export type ReviewerResult = GraphTeamResult & { report?: string; toolCalls?: number };

/** @deprecated Runtime always returns {@link GraphTeamResult}. Kept for type compatibility. */
export type AnalysisResult = GraphTeamResult & { rounds?: number };

export type ModelTeamResult = GraphTeamResult;

// ── Model Router / Leader-Dispatch (a /model routing layer, not a team) ──

/** A model target: a model id plus optional per-target provider config. */
export interface RouterModelRef {
  model: string;
  provider?: 'anthropic' | 'openai';
  baseURL?: string;
  /** Literal key or `$ENV_VAR` reference resolved at runtime. */
  apiKey?: string;
  maxTokens?: number;
}

/** One route = one specialist the leader can dispatch a turn to. */
export interface RouterRoute extends RouterModelRef {
  /** When the leader should dispatch this turn to this specialist. */
  when: string;
  /** Optional display label (defaults to role → name → model). */
  name?: string;
  /** The specialist's role/expertise (e.g. "frontend", "security"); used for the label and for matching. */
  role?: string;
  /** Optional richer description of the specialist's strengths, for the leader to weigh. */
  description?: string;
}

/**
 * A router profile = a Leader/Dispatch configuration under `/model`. The
 * `routerModel` is the leader: on each user input it dispatches the turn to the
 * single best specialist route; the turn then runs normally on that model (which
 * may be on a different provider), and that executor may itself convene a team.
 * Routing re-evaluates on the next user input.
 */
export interface RouterProfile {
  name: string;
  description?: string;
  /** The leader: classifies each turn and dispatches it to a specialist route. */
  routerModel: RouterModelRef;
  /** The specialist roster the leader dispatches among. */
  routes: RouterRoute[];
  /** Used when the leader matches no route. Defaults to the first route. */
  fallback?: RouterModelRef;
  /** Optional custom leader/dispatch-prompt prefix. */
  classificationPrompt?: string;
}

/** The outcome of classifying one user input against a router profile. */
export interface RouterDecision {
  /** The chosen model target (route, fallback, or first route). */
  target: RouterModelRef;
  /** Display label for the chosen target. */
  label: string;
  /** Raw classifier output (for telemetry/debug). */
  classification: string;
  /** Whether the classifier matched a configured route (vs fell back). */
  matched: boolean;
}

export interface ModelPricing {
  input: number;
  output: number;
}

export interface AgentPoolSlot {
  id: number;
  release: () => void;
}
