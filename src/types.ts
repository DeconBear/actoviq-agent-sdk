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

export type HadamardSettingsData = LoadedJsonConfigData;

export interface ToolExecutionContext {
  signal?: AbortSignal;
  runId: string;
  /** Stable provider tool-use id for lifecycle/relationship correlation. */
  toolUseId?: string;
  sessionId?: string;
  cwd: string;
  metadata: Record<string, unknown>;
  prompt: string;
  iteration: number;
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  classifier?: HadamardToolClassifier;
  approver?: HadamardToolApprover;
  hooks?: HadamardHooks;
  modelApi?: ModelApi;
  model?: string;
  provider?: string;
  effort?: HadamardEffort;
  /** Internal per-turn file journal supplied by the Hadamard runtime. */
  fileChangeJournal?: {
    record(change: {
      sessionId: string;
      turnId: string;
      filePath: string;
      before: Buffer | null;
      after: Buffer | null;
    }): Promise<unknown>;
  };
  /** OS isolation boundary, separate from the permission approval decision. */
  sandboxExecutor?: {
    readonly policy: import('./sandbox/types.js').SandboxPolicy;
    readonly capability: import('./sandbox/types.js').SandboxCapabilityReport;
    execute(
      request: import('./sandbox/types.js').SandboxExecutionRequest,
    ): Promise<import('./sandbox/types.js').SandboxExecutionResult>;
    assertPathAllowed(filePath: string, access: 'read' | 'write'): Promise<string>;
  };
}

export type HadamardPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'auto';

export type HadamardModelTier = 'min' | 'medium' | 'max';
export type HadamardEffort = 'low' | 'medium' | 'high' | 'max';
export type HadamardRunEffort = HadamardEffort | 'auto';

export interface HadamardModelTierConfig {
  min?: string;
  medium?: string;
  max?: string;
}

export type HadamardPermissionBehavior = 'allow' | 'deny' | 'ask';

export interface HadamardPermissionRule {
  toolName: string;
  behavior: HadamardPermissionBehavior;
  matcher?: string;
  source?: string;
}

export interface HadamardSessionPermissionState {
  mode?: HadamardPermissionMode;
  permissions: HadamardPermissionRule[];
}

export interface HadamardPermissionDecision {
  toolName: string;
  publicName: string;
  behavior: 'allow' | 'deny';
  reason: string;
  source: 'mode' | 'rule' | 'classifier' | 'approver' | 'canUseTool';
  matchedRule?: string;
  timestamp: string;
  /** When set, the conversation engine executes the tool with this input instead of the model-provided input. */
  updatedInput?: unknown;
}

export type HadamardClassifierOutcome =
  | {
      behavior: 'allow' | 'deny' | 'ask';
      reason: string;
    };

export interface HadamardToolClassifierContext {
  runId: string;
  sessionId?: string;
  workDir: string;
  toolName: string;
  publicName: string;
  input: unknown;
  prompt: string;
  iteration: number;
}

export type HadamardToolClassifier = (
  context: HadamardToolClassifierContext,
) => Promise<HadamardClassifierOutcome | void> | HadamardClassifierOutcome | void;

export interface HadamardToolApprovalContext extends HadamardToolClassifierContext {
  mode: HadamardPermissionMode;
  proposedBehavior: 'ask';
  reason: string;
  source: 'rule' | 'classifier';
  matchedRule?: string;
}

export type HadamardToolApprovalOutcome =
  | {
      behavior: 'allow' | 'deny';
      reason?: string;
      /** Optional replacement tool input (e.g. AskUserQuestion answers). */
      updatedInput?: unknown;
    };

export type HadamardToolApprover = (
  context: HadamardToolApprovalContext,
) =>
  | Promise<HadamardToolApprovalOutcome | void>
  | HadamardToolApprovalOutcome
  | void;

export interface HadamardCanUseToolContext {
  runId: string;
  sessionId?: string;
  workDir: string;
  toolName: string;
  publicName: string;
  input: unknown;
  prompt: string;
  iteration: number;
}

export type HadamardCanUseToolResult =
  | { behavior: 'allow' | 'deny' | 'ask'; reason?: string }
  | void;

export type HadamardCanUseTool = (
  context: HadamardCanUseToolContext,
) => Promise<HadamardCanUseToolResult> | HadamardCanUseToolResult;

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
  permissionMode?: HadamardPermissionMode;
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
    context: { mode: HadamardPermissionMode; runId: string; sessionId?: string },
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
    context: { mode: HadamardPermissionMode; runId: string; sessionId?: string },
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
  top_p?: number;
  tools?: ProviderTool[];
  tool_choice?: ToolChoice;
  metadata?: Metadata;
  context_management?: Record<string, unknown>;
  stop_sequences?: string[];
  extra_tool_schemas?: Record<string, unknown>[];
  effort?: HadamardEffort;
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
  interruptBehavior?: 'cancel' | 'block';
  /** Per-tool result size cap in chars before artifacting to disk. */
  maxResultSizeChars?: number;
  checkPermissions?: (
    context: { mode: HadamardPermissionMode; runId: string; sessionId?: string },
  ) => Promise<'allow' | 'deny' | 'ask' | void> | 'allow' | 'deny' | 'ask' | void;
}

export interface ResolvedRuntimeConfig {
  homeDir: string;
  loadedConfigPath?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model: string;
  modelTier?: HadamardModelTier;
  modelTiers: HadamardModelTierConfig;
  maxTokens: number;
  temperature?: number;
  /** Whole-run wall-clock deadline, including model/tool iterations. */
  runTimeoutMs: number;
  /** Local and MCP tool deadline. */
  toolTimeoutMs: number;
  /** Individual hook deadline. */
  hookTimeoutMs: number;
  /** MCP connect/catalog/call deadline. */
  mcpTimeoutMs: number;
  /** Provider request timeout retained for compatibility. */
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
  compact: HadamardCompactConfig;
  projectMemory: import('./config/projectSettings.js').ProjectMemorySettings;
  provider: 'anthropic' | 'openai';
  effort?: HadamardEffort;
  sandbox: import('./sandbox/types.js').SandboxPolicy;
  sandboxCapabilities: import('./sandbox/types.js').SandboxCapabilityReport;
  languageServers: import('./codeIntel/types.js').LanguageServerDefinition[];
  typedHooks: import('./hooks/hookTypes.js').TypedHookDefinition[];
  autoWorktree: boolean;
  /** Effective host/user/project/session policy applied to this runtime. */
  effectivePolicy: import('./policy/types.js').ResolvedPolicy;
}

export interface HadamardSessionStartHookContext {
  runId: string;
  input: string | MessageParam['content'];
  promptText: string;
  sessionId?: string;
  session?: StoredSession;
  workDir: string;
  options: AgentRunOptions;
}

export interface HadamardSessionStartHookResult {
  messages?: MessageParam[];
  systemPromptParts?: string[];
  metadata?: Record<string, unknown>;
}

export type HadamardSessionStartHook =
  | ((
      context: HadamardSessionStartHookContext,
    ) => Promise<HadamardSessionStartHookResult | void> | HadamardSessionStartHookResult | void);

export interface HadamardPostRunHookContext {
  runId: string;
  input: string | MessageParam['content'];
  promptText: string;
  sessionId?: string;
  session?: StoredSession;
  workDir: string;
  options: AgentRunOptions;
  result: AgentRunResult;
}

export interface HadamardPostRunHookResult {
  sessionMetadata?: Record<string, unknown>;
  tags?: string[];
}

export type HadamardPostRunHook =
  | ((
      context: HadamardPostRunHookContext,
    ) => Promise<HadamardPostRunHookResult | void> | HadamardPostRunHookResult | void);

export interface HadamardPostSamplingHookContext {
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

export type HadamardPostSamplingHook =
  | ((
      context: HadamardPostSamplingHookContext,
    ) => Promise<void> | void);

export interface HadamardStopHookContext {
  runId: string;
  sessionId?: string;
  messages: MessageParam[];
  assistantMessage: Message;
  systemPrompt?: string;
  stopHookActive: boolean;
  signal?: AbortSignal;
}

export interface HadamardHookBlockingError {
  command?: string;
  reason: string;
}

export interface HadamardStopHookResult {
  preventContinuation?: boolean;
  stopReason?: string;
  blockingErrors?: Array<string | HadamardHookBlockingError>;
  nonBlockingErrors?: Array<string | HadamardHookBlockingError>;
}

export type HadamardStopHook = (
  context: HadamardStopHookContext,
) => Promise<HadamardStopHookResult | void> | HadamardStopHookResult | void;

export interface HadamardHooks {
  sessionStart?: HadamardSessionStartHook[];
  postSampling?: HadamardPostSamplingHook[];
  postRun?: HadamardPostRunHook[];
  stopHooks?: HadamardStopHook[];
}

export interface HadamardAgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  effort?: HadamardRunEffort;
  permissionMode?: HadamardPermissionMode;
  maxToolIterations?: number;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  hooks?: HadamardHooks;
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

export interface HadamardAgentDefinitionSummary {
  name: string;
  description: string;
  model?: string;
  effort?: HadamardRunEffort;
  permissionMode?: HadamardPermissionMode;
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

export type HadamardSkillSource = 'bundled' | 'user' | 'project' | 'custom';

export type HadamardSkillLoadedFrom =
  | 'bundled'
  | 'skills'
  | 'commands'
  | 'custom';

export type HadamardSkillContextMode = 'inline' | 'fork';

export interface HadamardSkillPromptContext {
  args: string;
  workDir: string;
  homeDir: string;
  sessionId?: string;
  userId?: string;
}

export interface HadamardSkillPromptBuildResult {
  content: string | MessageParam['content'];
  systemPromptParts?: string[];
  metadata?: Record<string, unknown>;
}

export type HadamardSkillPromptBuilder = (
  args: string,
  context: HadamardSkillPromptContext,
) =>
  | Promise<string | MessageParam['content'] | HadamardSkillPromptBuildResult>
  | string
  | MessageParam['content']
  | HadamardSkillPromptBuildResult;

export interface HadamardSkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argNames?: string[];
  prompt?: string;
  buildPrompt?: HadamardSkillPromptBuilder;
  model?: string;
  effort?: HadamardEffort;
  /** Optional version string from frontmatter (display/telemetry only). */
  version?: string;
  /** Friendly display label from frontmatter `name:`; the invocation name still comes from the directory. */
  displayName?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  source?: HadamardSkillSource;
  loadedFrom?: HadamardSkillLoadedFrom;
  context?: HadamardSkillContextMode;
  agent?: string;
  hooks?: HadamardHooks;
  metadata?: Record<string, unknown>;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  inheritDefaultTools?: boolean;
  inheritDefaultMcpServers?: boolean;
  allowedTools?: string[];
  paths?: string[];
  skillRoot?: string;
}

export interface HadamardSkillDefinitionSummary {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argNames: string[];
  model?: string;
  effort?: HadamardEffort;
  version?: string;
  displayName?: string;
  source: HadamardSkillSource;
  loadedFrom: HadamardSkillLoadedFrom;
  context: HadamardSkillContextMode;
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

/**
 * Native CLI skill sources that the Hadamard runtime may reuse. User-level
 * sources are eligible by default; project-level sources remain disabled until
 * their source id is explicitly trusted.
 */
export interface HadamardExternalSkillsOptions {
  /** Limit discovery to these catalog source ids. Omit to use every external source. */
  enabledSourceIds?: string[];
  /** Exclude catalog sources without modifying their native runtime directories. */
  disabledSourceIds?: string[];
  /** Exclude individual catalog variants by their stable catalog id. */
  disabledSkillIds?: string[];
  /** Project source ids approved for this workspace, for example `codex:project`. */
  trustedProjectSourceIds?: string[];
  /** Resolve an invocation-name conflict to one catalog skill id. */
  preferredSkillIds?: Record<string, string>;
  /** Test/embedding seam for resolving native runtime home directories. */
  osHomeDir?: string;
  /** Environment seam for CLAUDE_CONFIG_DIR and CODEX_HOME overrides. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export type HadamardCleanToolCategory =
  | 'file'
  | 'task'
  | 'computer'
  | 'mcp'
  | 'custom';

export interface HadamardCleanToolMetadata {
  name: string;
  description: string;
  provider: 'local' | 'mcp';
  category: HadamardCleanToolCategory;
  server?: string;
  strict: boolean;
  readOnly: boolean;
  mutating: boolean;
  examples?: Array<Record<string, unknown>>;
}

export interface HadamardCleanToolCatalog {
  tools: HadamardCleanToolMetadata[];
  byCategory: Record<HadamardCleanToolCategory, HadamardCleanToolMetadata[]>;
}

export interface HadamardCleanToolLookupOptions {
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
}

export type HadamardCleanSlashCommandName =
  | 'context'
  | 'compact'
  | 'memory'
  | 'dream'
  | 'tools'
  | 'skills'
  | 'agents';

export interface HadamardCleanSlashCommandMetadata {
  name: HadamardCleanSlashCommandName;
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

export interface HadamardCleanContextOverviewOptions {
  sessionId?: string;
  includeMemory?: boolean;
  includeCompactState?: boolean;
  includeTools?: boolean;
  includeSkills?: boolean;
  includeAgents?: boolean;
  toolLookup?: HadamardCleanToolLookupOptions;
}

export interface HadamardCleanContextOverview {
  sessionId?: string;
  tools: HadamardCleanToolMetadata[];
  skills: HadamardSkillDefinitionSummary[];
  agents: HadamardAgentDefinitionSummary[];
  memoryState?: HadamardMemoryState;
  compactState?: HadamardCompactState;
}

export interface HadamardRunSlashCommandOptions {
  sessionId?: string;
  args?: string;
  compact?: AgentSessionCompactOptions;
  dream?: HadamardDreamRunOptions;
  memory?: Omit<HadamardMemoryStateOptions, 'projectPath' | 'sessionId'>;
  overview?: HadamardCleanContextOverviewOptions;
  toolLookup?: HadamardCleanToolLookupOptions;
}

export interface HadamardRunSlashCommandResult {
  name: HadamardCleanSlashCommandName;
  text: string;
  data:
    | HadamardCleanContextOverview
    | HadamardSessionCompactResult
    | HadamardMemoryState
    | HadamardDreamRunResult
    | HadamardDreamState
    | HadamardCleanToolMetadata[]
    | HadamardSkillDefinitionSummary[]
    | HadamardAgentDefinitionSummary[]
    | import('./memory/memoryCommandService.js').HadamardMemoryCommandResult;
}

export interface HadamardInvokedSkillRecord {
  name: string;
  args?: string;
  content: string;
  invokedAt: string;
  source: HadamardSkillSource;
  loadedFrom: HadamardSkillLoadedFrom;
  context: HadamardSkillContextMode;
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
  runTimeoutMs?: number;
  toolTimeoutMs?: number;
  hookTimeoutMs?: number;
  mcpTimeoutMs?: number;
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
  agents?: HadamardAgentDefinition[];
  agentDirectories?: string[];
  loadDefaultAgentDirectories?: boolean;
  disableDefaultAgents?: boolean;
  maxSubagentDepth?: number;
  maxSubagentFanout?: number;
  skills?: HadamardSkillDefinition[];
  skillDirectories?: string[];
  /** Reuse user-configured Claude Code, Codex, Cursor, cc-switch, and shared-agent skills. */
  externalSkills?: boolean | HadamardExternalSkillsOptions;
  disableDefaultSkills?: boolean;
  loadDefaultSkillDirectories?: boolean;
  hooks?: HadamardHooks;
  compact?: Partial<HadamardCompactConfig>;
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  classifier?: HadamardToolClassifier;
  approver?: HadamardToolApprover;
  computerUse?: boolean | CreateHadamardComputerUseOptions;
  /** Opt-in Playwright browser automation tools (browser-use style snapshot/index actions). */
  browserUse?: boolean | CreateHadamardBrowserUseOptions;
  provider?: 'anthropic' | 'openai';
  effort?: HadamardEffort;
  modelApi?: ModelApi;
  sessionManager?: SessionManagerConfig;
  sandbox?: import('./sandbox/policyResolver.js').SandboxPolicyInput;
  languageServers?: import('./codeIntel/types.js').LanguageServerDefinition[];
  /** Typed lifecycle hooks shared by SDK, GUI, TUI, and CLI runtimes. */
  typedHooks?: import('./hooks/hookTypes.js').TypedHookDefinition[];
  /** Create a durable Session-owned git worktree for new main Sessions. */
  autoWorktree?: boolean;
  /** Additional session-scoped managed policy documents. */
  policyDocuments?: import('./policy/types.js').PolicyDocument[];
}

export interface HadamardCompactConfig {
  enabled: boolean;
  /** @deprecated Use autoCompactTokenLimit. Retained as a legacy explicit override. */
  autoCompactThresholdTokens?: number;
  /** Explicit limit, clamped to 90% of the raw context window. */
  autoCompactTokenLimit?: number;
  autoCompactTokenLimitScope?: 'total' | 'body_after_prefix';
  preserveRecentMessages: number;
  preserveRecentUserTokens?: number;
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
  maxContextWindowTokens?: number;
  effectiveContextWindowPercent?: number;
  contextWindowSource?: 'run' | 'project' | 'global' | 'model_catalog' | 'fallback';
  contextWindowWarning?: string;
  deprecationWarnings?: string[];
  /** @deprecated Use autoCompactTokenLimit. */
  loopAutoCompactThresholdTokens?: number;
  /**
   * Persistent user guidance injected into every compact summary prompt.
   * Use this to steer what the summarizer prioritises, e.g.
   * "Focus on architecture decisions; ignore formatting discussions."
   * Merged with per-call summaryInstructions (per-call takes precedence).
   */
  compactInstructions?: string;
  /**
   * Controls how prescriptive the compact summary prompt is.
   * - 'hybrid' (default): adaptive sections + mandatory user-message list.
   * - 'structured': fixed 9-section format (best for weaker models).
   * - 'free': Codex-style free-form handoff (best for strong models).
   */
  compactPromptMode?: 'hybrid' | 'structured' | 'free';
}

export type HadamardWorkspaceKind = 'directory' | 'temp' | 'git-worktree';

export interface HadamardWorkspaceInfo {
  id: string;
  kind: HadamardWorkspaceKind;
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
  topP?: number;
  toolChoice?: ToolChoice;
  userId?: string;
  metadata?: Record<string, unknown>;
  effort?: HadamardRunEffort;
  hooks?: HadamardHooks;
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  classifier?: HadamardToolClassifier;
  approver?: HadamardToolApprover;
  canUseTool?: HadamardCanUseTool;
  signal?: AbortSignal;
  /**
   * Mid-run steering: called between tool iterations to collect user messages
   * queued while the agent was working. Drained texts are appended to the
   * next tool-result user message so the model sees them on its next request.
   */
  drainQueuedInputs?: () => string[] | Promise<string[]>;
  /**
   * Follow-up queue: drained only after the model reaches a natural stopping
   * point. Follow-ups continue the same run without racing a second session
   * turn against the active one.
   */
  drainFollowUpInputs?: () => string[];
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
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  initialMessages?: MessageParam[];
  /** Durable conversation kind. Agent sessions remain independently resumable. */
  kind?: 'main' | 'worktree' | 'manager' | 'agent';
  /** Direct conversation parent. This is execution topology, not transcript forking. */
  parentSessionId?: string;
  /** Stable source message where a conversation branch diverged. */
  parentMessageId?: string;
  /** User-visible label for a branch in the Session tree. */
  branchName?: string;
  originalWorkDir?: string;
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
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
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
  /** Root Agent execution tree for this run. */
  executionId?: string;
  /** Stable node for the Agent conversation that produced this result. */
  executionNodeId?: string;
  model: string;
  text: string;
  message: Message;
  messages: MessageParam[];
  surfacedMemories?: HadamardSurfacedMemory[];
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
  delegatedAgents?: HadamardDelegatedAgentRecord[];
  invokedSkills?: HadamardInvokedSkillRecord[];
  reactiveCompact?: HadamardSessionCompactResult;
  /** Mid-run conversation compactions performed inside the tool loop. */
  loopCompactions?: AgentLoopCompactionRecord[];
  permissionDecisions?: HadamardPermissionDecision[];
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

export interface HadamardDreamConfig {
  minHours: number;
  minSessions: number;
  scanIntervalMs: number;
  minRolloutIdleHours?: number;
  maxRolloutAgeDays?: number;
  maxRolloutsPerStartup?: number;
}

export interface HadamardDreamPaths {
  memoryDir: string;
  teamMemoryDir: string;
  memoryEntrypoint: string;
  teamMemoryEntrypoint: string;
  transcriptDir: string;
  lockPath: string;
  stateDbPath: string;
  rawMemoriesPath: string;
  rolloutSummariesDir: string;
  memorySummaryPath: string;
}

export interface HadamardDreamState {
  enabled: boolean;
  autoMemoryEnabled: boolean;
  config: HadamardDreamConfig;
  paths: HadamardDreamPaths;
  currentSessionId?: string;
  lastConsolidatedAtMs: number;
  lastConsolidatedAt?: string;
  hoursSinceLastConsolidated: number;
  sessionsSinceLastConsolidated: string[];
  lockHeld: boolean;
  eligibleRolloutCount?: number;
  phase?: 'idle' | 'extracting' | 'consolidating';
  leaseExpiresAt?: string;
  lastError?: string;
  canRun: boolean;
  blockedReason?:
    | 'disabled'
    | 'time_gate'
    | 'session_gate'
    | 'locked'
    | 'scan_throttled'
    | 'missing_execution_profile';
}

export interface HadamardDreamRunOptions {
  force?: boolean;
  background?: boolean;
  currentSessionId?: string;
  extraContext?: string;
  model?: string;
  executionProfile?: import('./config/projectSettings.js').DreamExecutionProfileRef;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface HadamardDreamRunResult {
  success: boolean;
  skipped: boolean;
  trigger: 'manual' | 'auto';
  reason?: string;
  state: HadamardDreamState;
  touchedSessions: string[];
  touchedFiles: string[];
  result?: AgentRunResult;
  task?: HadamardBackgroundTaskRecord;
}

export type HadamardCompactTrigger = 'auto' | 'manual' | 'reactive';

export interface AgentSessionCompactOptions {
  force?: boolean;
  model?: string;
  maxTokens?: number;
  preserveRecentMessages?: number;
  summaryInstructions?: string;
  signal?: AbortSignal;
}

export interface HadamardSessionCompactResult {
  compacted: boolean;
  trigger: HadamardCompactTrigger;
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
  state: HadamardSessionMemoryRuntimeState;
  budget?: {
    rawContextWindowTokens: number;
    effectiveContextWindowTokens: number;
    autoCompactTokenLimit: number;
    source: 'explicit' | 'derived' | 'fallback';
  };
}

export interface HadamardTaskToolInput {
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

export interface HadamardTaskToolSyncResult {
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

export interface HadamardTaskToolAsyncResult {
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

export type HadamardTaskToolResult =
  | HadamardTaskToolSyncResult
  | HadamardTaskToolAsyncResult;

export interface HadamardDelegatedAgentRecord {
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

export interface HadamardAgentContinuityState {
  currentAgent?: string;
  delegatedAgents: HadamardDelegatedAgentRecord[];
}

export type HadamardBackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface HadamardBackgroundTaskQueuedInput {
  /** Stable collaboration tool-use id; also provides replay idempotency. */
  id: string;
  text: string;
  rootExecutionId: string;
  edgeCallId: string;
}

export interface HadamardBackgroundTaskRecord {
  id: string;
  status: HadamardBackgroundTaskStatus;
  /** Process that owns the live worker; used to avoid cross-process false recovery. */
  ownerPid?: number;
  /** Stable manager instance that launched the worker. */
  ownerInstanceId?: string;
  /** Lease heartbeat used to distinguish a live owner from PID reuse. */
  ownerHeartbeatAt?: string;
  /** Durable cross-process follow-ups waiting for the worker's next input boundary. */
  queuedInputs?: HadamardBackgroundTaskQueuedInput[];
  /** Bounded replay guard retained after queued inputs are drained. */
  seenInputIds?: string[];
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
  executionId?: string;
  executionNodeId?: string;
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

export interface HadamardMailboxMessage {
  id: string;
  teamName: string;
  to: string;
  from: string;
  kind: 'status' | 'task' | 'user';
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface HadamardTeammateRecord {
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
  lastTaskStatus?: HadamardBackgroundTaskStatus;
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

export interface CreateHadamardTeammateOptions {
  name: string;
  agent: string;
  prompt: string;
}

export interface CreateHadamardSwarmOptions {
  name: string;
  leader?: string;
  continuous?: boolean;
}

export interface HadamardSwarmRunResult {
  teammate: HadamardTeammateRecord;
  task?: HadamardBackgroundTaskRecord;
  result?: AgentRunResult;
  source?: 'prompt' | 'mailbox' | 'background';
  mailboxMessagesProcessed?: number;
}

export interface HadamardSwarmRuntimeContext {
  hooks?: HadamardHooks;
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  classifier?: HadamardToolClassifier;
  approver?: HadamardToolApprover;
}

export interface HadamardTeammateTranscript {
  teammate: HadamardTeammateRecord;
  sessionId: string;
  messages: MessageParam[];
  leaderInbox: HadamardMailboxMessage[];
  teammateInbox: HadamardMailboxMessage[];
}

export interface HadamardComputerUseExecutor {
  openUrl(url: string, signal?: AbortSignal): Promise<void> | void;
  focusWindow?(title: string, signal?: AbortSignal): Promise<void> | void;
  typeText(text: string, signal?: AbortSignal): Promise<void> | void;
  keyPress(keys: string[], signal?: AbortSignal): Promise<void> | void;
  readClipboard(signal?: AbortSignal): Promise<string> | string;
  writeClipboard(text: string, signal?: AbortSignal): Promise<void> | void;
  takeScreenshot(outputPath: string, signal?: AbortSignal): Promise<string> | string;
}

export interface CreateHadamardComputerUseOptions {
  prefix?: string;
  executor?: HadamardComputerUseExecutor;
  asMcpServer?: boolean;
  serverName?: string;
}

export interface CreateHadamardBrowserUseOptions {
  prefix?: string;
  asMcpServer?: boolean;
  serverName?: string;
  headless?: boolean;
  channel?: 'chromium' | 'chrome' | 'msedge';
  cdpUrl?: string;
  userDataDir?: string;
  /** Root directory for screenshot output paths. Defaults to process.cwd(). */
  workspaceDir?: string;
  allowedDomains?: string[];
  defaultTimeoutMs?: number;
  viewport?: { width: number; height: number };
  /** Enable browser_evaluate (off by default). */
  allowEvaluate?: boolean;
  /** Inject a session (tests / custom backends). */
  session?: {
    navigate(url: string, opts?: { newTab?: boolean }): Promise<{ tabId: string; url: string; title: string }>;
    goBack(): Promise<{ url: string; title: string }>;
    wait(ms: number): Promise<void>;
    snapshot(opts?: { interactiveOnly?: boolean; maxElements?: number }): Promise<unknown>;
    click(target: { index?: number; x?: number; y?: number }): Promise<{ ok: true }>;
    type(input: { index: number; text: string; clear?: boolean; submit?: boolean }): Promise<{ ok: true }>;
    press(keys: string): Promise<{ ok: true }>;
    scroll(input: { direction: 'up' | 'down'; pages?: number; index?: number }): Promise<{ ok: true }>;
    screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<{ path?: string; base64?: string }>;
    tabsDetailed(): Promise<unknown>;
    switchTab(tabId: string): Promise<{ ok: true; tabId: string }>;
    closeTab(tabId?: string): Promise<{ ok: true; closed: string }>;
    extract(): Promise<{ url: string; title: string; text: string }>;
    evaluate?(expression: string): Promise<{ result: unknown }>;
    close(): Promise<void>;
  };
}

export interface WaitForHadamardBackgroundTaskOptions {
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
      type: 'request.prompt_cache';
      runId: string;
      iteration: number;
      prefixSignature: string;
      prefixChanged: boolean;
      breakpoints: {
        system: boolean;
        tools: boolean;
        message: boolean;
      };
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
      type: 'response.thinking.delta';
      runId: string;
      iteration: number;
      index: number;
      delta: string;
      snapshot: string;
      signature?: string;
      timestamp: string;
    }
  | {
      type: 'response.tool_input.delta';
      runId: string;
      iteration: number;
      index: number;
      toolUseId?: string;
      toolName?: string;
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
      decision: HadamardPermissionDecision;
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
      trigger: HadamardCompactTrigger;
      result: HadamardSessionCompactResult;
      timestamp: string;
    }
  | {
      type: 'checkpoint.created';
      runId: string;
      sessionId: string;
      checkpointId: string;
      timestamp: string;
    }
  | {
      type:
        | 'checkpoint.restore.requested'
        | 'checkpoint.restore.completed'
        | 'checkpoint.restore.conflicted';
      runId: string;
      sessionId: string;
      checkpointId: string;
      timestamp: string;
    }
  | {
      type: 'sandbox.applied' | 'sandbox.degraded' | 'sandbox.violation';
      runId: string;
      sessionId?: string;
      capability: import('./sandbox/types.js').SandboxCapabilityReport;
      violation?: import('./sandbox/types.js').SandboxViolation;
      timestamp: string;
    }
  | {
      type: 'hook.lifecycle';
      runId: string;
      sessionId?: string;
      lifecycleEvent: import('./hooks/hookTypes.js').HadamardLifecycleEvent;
      outputs: import('./hooks/hookTypes.js').TypedHookOutput[];
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
      /** Projector event for a root/child Agent execution graph. */
      type: 'agent.execution';
      runId: string;
      rootExecutionId: string;
      event: import('./runtime/agentExecution.js').AgentExecutionEvent;
      snapshot: import('./runtime/agentExecution.js').AgentExecutionSnapshot;
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
  /** Monotonic compare-and-swap revision. Legacy v1 snapshots without it load as revision 0. */
  revision: number;
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
  // ── Durable interactive-surface / worktree fields ──
  kind?: 'main' | 'worktree' | 'manager' | 'agent';
  worktreePath?: string;
  worktreeBranch?: string;
  parentSessionId?: string;
  parentMessageId?: string;
  branchName?: string;
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
  /** First-user-prompt style label for conversation lists. */
  brief?: string;
  messageCount: number;
  runCount: number;
  /** True when the session file lives in the project archive/ directory. */
  archived?: boolean;
  /** User pin used by Session Center sorting. */
  pinned?: boolean;
  /** Session kind — Agent sessions are independent child conversations. */
  kind?: 'main' | 'worktree' | 'manager' | 'agent';
  /** Direct parent conversation for an Agent/worktree session. */
  parentSessionId?: string;
  /** Stable Agent execution node linked to this conversation. */
  executionId?: string;
  /** Root execution tree containing this Agent. */
  rootExecutionId?: string;
  /** Named Agent definition or assigned nickname. */
  agentName?: string;
  /** Stable canonical Agent path such as `/root/reviewer`. */
  agentPath?: string;
  /** Project issue linked to this session, when the session was created from an issue dispatch. */
  issueId?: string;
  issueNumber?: number;
  issueKey?: string;
  agentProfile?: string;
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
  /** Locator for the separate file-change manifest; file bodies never live in Session JSON. */
  fileManifestLocator?: string;
}

export interface SessionCheckpointSummary {
  id: string;
  label: string;
  createdAt: string;
}


export interface HadamardMemorySettings {
  autoCompactEnabled?: boolean;
  autoMemoryEnabled?: boolean;
  autoDreamEnabled?: boolean;
  autoMemoryDirectory?: string;
}

export interface UpdateHadamardMemorySettingsInput {
  autoCompactEnabled?: boolean;
  autoMemoryEnabled?: boolean;
  autoDreamEnabled?: boolean;
  autoMemoryDirectory?: string | null;
}

export interface HadamardMemoryPaths {
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

export interface HadamardSessionMemoryState {
  exists: boolean;
  path?: string;
  content?: string;
  isEmpty?: boolean;
  tokenEstimate?: number;
  truncatedContent?: string;
  wasTruncated?: boolean;
}

export interface HadamardSessionMemoryConfig {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenUpdate: number;
  /** @deprecated Tool calls no longer gate extraction. */
  toolCallsBetweenUpdates: number;
  maxOutputTokens: number;
}

export interface HadamardSessionMemoryCompactConfig {
  minTokens: number;
  minTextBlockMessages: number;
  maxTokens: number;
}

export interface HadamardSessionMemoryProgress {
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

export interface HadamardSessionMemoryRuntimeState {
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

export interface AgentSessionDreamOptions extends HadamardDreamRunOptions {}

export interface HadamardSessionMemoryExtractionResult {
  success: boolean;
  skipped: boolean;
  updated: boolean;
  trigger: 'auto' | 'manual';
  reason?: string;
  sessionId?: string;
  memoryPath?: string;
  summary?: string;
  usage?: Usage;
  state: HadamardSessionMemoryRuntimeState;
}

export interface HadamardMemoryOptions {
  configPath?: string;
  homeDir?: string;
  projectPath?: string;
  sessionId?: string;
  sessionMemoryConfig?: Partial<HadamardSessionMemoryConfig>;
  enabledOverrides?: Partial<{
    autoCompact: boolean;
    autoMemory: boolean;
    autoDream: boolean;
  }>;
}

export interface HadamardMemoryPromptOptions extends HadamardMemoryOptions {
  extraGuidelines?: string[];
  skipIndex?: boolean;
}

export interface HadamardMemoryStateOptions extends HadamardMemoryPromptOptions {
  includeCombinedPrompt?: boolean;
  includeSessionMemory?: boolean;
  includeSessionTemplate?: boolean;
  includeSessionPrompt?: boolean;
}

export interface HadamardCompactStateOptions extends HadamardMemoryStateOptions {
  includeBoundaries?: boolean;
  includeSummaryMessage?: boolean;
  currentTokenCount?: number;
  tokensAtLastExtraction?: number;
  initialized?: boolean;
  hasToolCallsInLastTurn?: boolean;
  messageCountSinceLastExtraction?: number;
  toolCallsSinceLastUpdate?: number;
  runtimeState?: HadamardSessionMemoryRuntimeState;
}

export interface HadamardMemoryState {
  settings: HadamardMemorySettings;
  enabled: {
    autoCompact: boolean;
    autoMemory: boolean;
    autoDream: boolean;
  };
  paths: HadamardMemoryPaths;
  combinedPrompt?: string;
  sessionMemory?: HadamardSessionMemoryState;
  sessionTemplate?: string;
  sessionPrompt?: string;
}

export interface HadamardCompactState extends HadamardMemoryState {
  sessionMemoryConfig: HadamardSessionMemoryConfig;
  sessionMemoryCompactConfig: HadamardSessionMemoryCompactConfig;
  progress?: HadamardSessionMemoryProgress;
  runtimeState?: HadamardSessionMemoryRuntimeState;
  agentContinuity?: HadamardAgentContinuityState;
  invokedSkills?: HadamardInvokedSkillRecord[];
  transcriptPath?: string;
  boundaries?: HadamardTranscriptBoundary[];
  latestBoundary?: HadamardTranscriptBoundary;
  compactCount: number;
  microcompactCount: number;
  consecutiveCompactFailures?: number;
  lastCompactFailureAt?: string;
  lastCompactError?: string;
  hasCompacted: boolean;
  pendingPostCompaction?: boolean;
  lastSummarizedMessageUuid?: string;
  latestPreservedSegment?: HadamardPreservedSegment;
  latestBoundarySummary?: string;
  canUseSessionMemoryCompaction: boolean;
  summaryMessage?: string;
}

export interface HadamardMemoryFileHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description?: string | null;
  type?: string;
  scope: 'private' | 'team';
}

export interface HadamardRelevantMemory {
  filename: string;
  path: string;
  mtimeMs: number;
  description?: string | null;
  type?: string;
  scope: 'private' | 'team';
  score?: number;
}

export interface HadamardSurfacedMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
  limit?: number;
  scope: 'private' | 'team';
  freshnessText?: string;
}

export interface HadamardRelevantMemoryLookupOptions extends HadamardMemoryOptions {
  recentTools?: string[];
  alreadySurfacedPaths?: Iterable<string>;
  limit?: number;
}

export interface HadamardPreservedSegment {
  headUuid: string;
  anchorUuid: string;
  tailUuid: string;
}

export interface HadamardCompactBoundaryMetadata {
  trigger?: string;
  preTokens?: number;
  userContext?: string;
  messagesSummarized?: number;
  preservedMessages?: number;
  droppedMessages?: number;
  retryCount?: number;
  continuationDepth?: number;
  preservedSegment?: HadamardPreservedSegment;
}

export interface HadamardMicrocompactBoundaryMetadata {
  trigger?: string;
  preTokens?: number;
  tokensSaved?: number;
  compactedToolIds?: string[];
  clearedAttachmentUUIDs?: string[];
}

export interface HadamardTranscriptBoundary {
  kind: 'compact' | 'microcompact';
  uuid: string;
  timestamp: string;
  sessionId: string;
  logicalParentUuid?: string | null;
  metadata?: HadamardCompactBoundaryMetadata | HadamardMicrocompactBoundaryMetadata;
  raw: Record<string, unknown>;
}

export const HADAMARD_BUDDY_RARITIES = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const;
export type HadamardBuddyRarity = (typeof HADAMARD_BUDDY_RARITIES)[number];

export const HADAMARD_BUDDY_SPECIES = [
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
export type HadamardBuddySpecies = (typeof HADAMARD_BUDDY_SPECIES)[number];

export const HADAMARD_BUDDY_EYES = ['o_o', '^_^', '-_-', '@_@', '>_<', 'x_x'] as const;
export type HadamardBuddyEye = (typeof HADAMARD_BUDDY_EYES)[number];

export const HADAMARD_BUDDY_HATS = [
  'none',
  'crown',
  'tophat',
  'propeller',
  'halo',
  'wizard',
  'beanie',
  'tinyduck',
] as const;
export type HadamardBuddyHat = (typeof HADAMARD_BUDDY_HATS)[number];

export const HADAMARD_BUDDY_STAT_NAMES = [
  'DEBUGGING',
  'PATIENCE',
  'CHAOS',
  'WISDOM',
  'SNARK',
] as const;
export type HadamardBuddyStatName = (typeof HADAMARD_BUDDY_STAT_NAMES)[number];

export interface HadamardBuddyBones {
  rarity: HadamardBuddyRarity;
  species: HadamardBuddySpecies;
  eye: HadamardBuddyEye;
  hat: HadamardBuddyHat;
  shiny: boolean;
  stats: Record<HadamardBuddyStatName, number>;
}

export interface HadamardBuddySoul {
  name: string;
  personality: string;
}

export interface StoredHadamardBuddy extends HadamardBuddySoul {
  hatchedAt: number;
}

export interface HadamardBuddyCompanion extends HadamardBuddyBones, HadamardBuddySoul {
  hatchedAt: number;
}

export interface HadamardBuddyRoll {
  bones: HadamardBuddyBones;
  inspirationSeed: number;
}

export interface HadamardBuddyState {
  configPath: string;
  userId: string;
  muted: boolean;
  buddy?: HadamardBuddyCompanion;
}

export interface HadamardBuddyReaction {
  buddy: HadamardBuddyCompanion;
  reaction: string;
  petAt: number;
}

export interface HadamardBuddyIntroAttachment {
  type: 'companion_intro';
  name: string;
  species: HadamardBuddySpecies;
}

export interface HadamardBuddyPromptContext {
  buddy: HadamardBuddyCompanion;
  attachment: HadamardBuddyIntroAttachment;
  text: string;
}

export interface HadamardBuddyOptions {
  configPath?: string;
  homeDir?: string;
  userId?: string;
}

export interface HatchHadamardBuddyOptions extends HadamardBuddyOptions {
  name: string;
  personality: string;
}

export interface HadamardBuddyPromptContextOptions extends HadamardBuddyOptions {
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
export type ScheduledAutomationWorkflowSource = 'agent' | 'script';

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
  /** Agent-page workflow for new tasks; absent/script preserves the legacy script runtime. */
  workflowSource?: ScheduledAutomationWorkflowSource;
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
  workflowSource?: ScheduledAutomationWorkflowSource;
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

export type HadamardBridgePermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

export type HadamardBridgeToolsOption = 'default' | 'none' | string[];

/**
 * Which agent CLI directCli mode drives. `claude` (default) uses Claude Code's
 * `-p` stream-json protocol; `pi` and `codex` reuse the same spawn + JSONL
 * pipeline with their own wire protocols.
 */
export type RuntimeProviderId = 'claude' | 'pi' | 'codex' | 'codewhale' | 'reasonix' | 'crush';

/** Authentication source for an externally launched agent CLI. */
export type HadamardBridgeAuthSource = 'native' | 'apiKey';

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

export interface HadamardBridgeJsonEvent extends Record<string, unknown> {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
}

export interface CreateHadamardBridgeSdkOptions {
  executable?: string;
  cliPath?: string;
  /**
   * Spawn a locally installed agent CLI directly, bypassing the vendored
   * `runtime.bundle.br` + Bun wrapper. When true, `executable` is the CLI to
   * spawn (defaults to the provider's binary on PATH). Provider isolation
   * follows `authSource`: native CLI state by default, or explicit child-only
   * environment injection for `apiKey`.
   */
  directCli?: boolean;
  /**
   * Which agent CLI directCli mode drives. Defaults to `claude` (Claude Code
   * `-p` stream-json). `pi` and `codex` reuse the same spawn + JSONL pipeline
   * but speak their own wire protocols — see `src/parity/bridgeProviders.ts`.
   * Only consulted when `directCli` is true; ignored by the bundle path.
   */
  directCliProvider?: RuntimeProviderId;
  /**
   * `native` reuses the CLI's own login/configuration without mapping Hadamard
   * API settings into provider credential variables. `apiKey` injects the
   * explicit key below into this child process only. Direct CLI mode defaults
   * to `native`; the vendored bridge keeps its legacy settings mapping.
   */
  authSource?: HadamardBridgeAuthSource;
  /** Explicit per-child credential used only when authSource is `apiKey`. */
  apiKey?: string;
  /** Optional per-child provider endpoint used only when authSource is `apiKey`. */
  baseURL?: string;
  /** Native provider id used by multi-provider CLIs for child-only API-key mapping. */
  credentialProvider?: string;
  /**
   * Stable, non-secret identity for a managed external CLI configuration.
   * Hadamard-owned session profiles use it across process restarts without
   * including the credential itself in a filesystem path or hash.
   */
  profileName?: string;
  homeDir?: string;
  workDir?: string;
  model?: string;
  fallbackModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: HadamardBridgePermissionMode;
  /** Trust and load project-local runtime resources when the selected CLI supports it (Pi). */
  trustProjectResources?: boolean;
  dangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  agent?: string;
  agents?: Record<string, unknown>;
  tools?: HadamardBridgeToolsOption;
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

export interface HadamardBridgeRunOptions extends CreateHadamardBridgeSdkOptions {
  sessionId?: string;
  resume?: string | true;
  continueMostRecent?: boolean;
  forkSession?: boolean;
  name?: string;
  signal?: AbortSignal;
}

export interface HadamardBridgeSessionCreateOptions
  extends Omit<
    HadamardBridgeRunOptions,
    'continueMostRecent' | 'forkSession' | 'name' | 'resume' | 'sessionId' | 'signal'
  > {
  sessionId?: string;
  title?: string;
}

export type HadamardBridgeAgentRunOptions = Omit<HadamardBridgeRunOptions, 'agent'>;
export type HadamardBridgeAgentSessionOptions = Omit<HadamardBridgeSessionCreateOptions, 'agent'>;
export type HadamardBridgeSkillRunOptions = Omit<HadamardBridgeRunOptions, 'resume' | 'sessionId'>;

export interface HadamardBridgeRunResult {
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
  initEvent?: HadamardBridgeJsonEvent;
  resultEvent: HadamardBridgeJsonEvent;
  assistantMessages: HadamardBridgeJsonEvent[];
  events: HadamardBridgeJsonEvent[];
}

export interface HadamardRuntimeMcpServer {
  name: string;
  status?: string;
}

export interface HadamardRuntimePluginInfo {
  name: string;
  path?: string;
  source?: string;
}

export interface HadamardRuntimeInfo {
  sessionId: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools: string[];
  mcpServers: HadamardRuntimeMcpServer[];
  slashCommands: string[];
  agents: string[];
  skills: string[];
  plugins: HadamardRuntimePluginInfo[];
  rawInitEvent: HadamardBridgeJsonEvent;
}

export interface HadamardAgentSummary {
  name: string;
  sourceGroup: string;
  active: boolean;
  rawLine: string;
  model?: string;
  memory?: string;
  shadowedBy?: string;
}

export interface HadamardAgentMetadata extends HadamardAgentSummary {
  contextSource?: string;
  tokens?: string;
}

export interface HadamardToolMetadata {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  tokens?: string;
}

export interface HadamardSkillMetadata {
  name: string;
  slashCommand: string;
  source?: string;
  tokens?: string;
}

export interface HadamardSlashCommandMetadata {
  name: string;
  kind: 'builtin' | 'skill';
  skillName?: string;
}

export interface HadamardRuntimeCatalog {
  runtime: HadamardRuntimeInfo;
  agents: HadamardAgentMetadata[];
  tools: HadamardToolMetadata[];
  skills: HadamardSkillMetadata[];
  slashCommands: HadamardSlashCommandMetadata[];
  context?: HadamardContextUsage;
}

export interface HadamardContextCategory {
  name: string;
  tokens: string;
  percentage: string;
}

export interface HadamardContextSkillUsage {
  name: string;
  source?: string;
  tokens: string;
}

export interface HadamardContextAgentUsage {
  agentType: string;
  source?: string;
  tokens: string;
}

export interface HadamardContextMcpToolUsage {
  tool: string;
  server: string;
  tokens: string;
}

export interface HadamardContextUsage {
  markdown: string;
  model?: string;
  tokensUsed?: string;
  tokenLimit?: string;
  percentage?: number;
  categories: HadamardContextCategory[];
  skills: HadamardContextSkillUsage[];
  agents: HadamardContextAgentUsage[];
  mcpTools: HadamardContextMcpToolUsage[];
  rawResult: HadamardBridgeRunResult;
}

export interface HadamardBridgeCapabilityLookupOptions
  extends Omit<HadamardBridgeRunOptions, 'resume' | 'sessionId'> {
  includeContext?: boolean;
}

export type HadamardCleanBridgeParityStatus =
  | 'exact'
  | 'mapped'
  | 'simulated'
  | 'unsupported';

export interface HadamardCleanBridgeParityMatrixEntry {
  option: keyof HadamardBridgeRunOptions | keyof CreateHadamardBridgeSdkOptions;
  status: HadamardCleanBridgeParityStatus;
  cleanTarget?: string;
  notes: string;
}

export interface HadamardCleanBridgeUnsupportedOption {
  option: string;
  value: unknown;
  reason: string;
}

export interface HadamardCleanBridgeCompatibilityReport {
  mapped: Array<{
    option: string;
    cleanTarget: string;
    status: Exclude<HadamardCleanBridgeParityStatus, 'unsupported'>;
    note?: string;
  }>;
  unsupported: HadamardCleanBridgeUnsupportedOption[];
}

export type HadamardCleanBridgeUnsupportedOptionPolicy = 'metadata' | 'warn' | 'throw';

export interface CreateHadamardCleanBridgeSdkOptions extends CreateAgentSdkOptions {
  bridgeDefaults?: CreateHadamardBridgeSdkOptions;
  unsupportedOptionPolicy?: HadamardCleanBridgeUnsupportedOptionPolicy;
}

export type HadamardBridgeToolProvider = 'runtime' | 'server' | 'mcp' | 'unknown';

export interface HadamardBridgeToolRequest {
  id?: string;
  name: string;
  provider: HadamardBridgeToolProvider;
  blockType: string;
  input?: unknown;
}

export interface HadamardBridgeToolResultSummary {
  toolUseId: string;
  isError: boolean;
  blockType: string;
  content?: unknown;
}

export interface HadamardBridgeTaskInvocation {
  id?: string;
  name: string;
  provider: HadamardBridgeToolProvider;
  description?: string;
  prompt?: string;
  subagentType?: string;
  input: Record<string, unknown>;
}

export interface HadamardBridgeEventAnalysis {
  textDeltas: string[];
  toolRequests: HadamardBridgeToolRequest[];
  toolResults: HadamardBridgeToolResultSummary[];
  taskInvocations: HadamardBridgeTaskInvocation[];
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
  /** Children: branch=[if,else], parallel=all, agent=[] or one sequential continuation. */
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
 * 'return'` (exactly one Caller Exit) terminates the run. Absent `kind` → `agent` (v2 compat).
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
  /**
   * GUI canvas position / grouping (pixels). Ignored by the graph engine.
   * `groupId` ties the node to a visual `TeamDefinition.uiGroups` cluster.
   */
  ui?: { x?: number; y?: number; groupId?: string };
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
    /**
     * GUI-only attachment side for smart routing (`n`/`e`/`s`/`w`).
     * When absent, the canvas migrates from legacy top-in/bottom-out ports.
     */
    fromSide?: 'n' | 'e' | 's' | 'w';
    toSide?: 'n' | 'e' | 's' | 'w';
    /** When true, auto `pickShortestSides` skips this edge after a manual endpoint drag. */
    sideLocked?: boolean;
  };
}

/** GUI-only visual cluster for Parallel/Loop insert shortcuts (engine ignores). */
export interface TeamGraphUiGroup {
  id: string;
  kind: 'parallel' | 'loop';
  label?: string;
  memberRefs: string[];
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
  /**
   * GUI-only Parallel/Loop visual clusters. Ignored by the graph engine.
   * Insert Parallel/Loop writes these; users can ungroup without changing topology.
   */
  uiGroups?: TeamGraphUiGroup[];
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
  /** Permission policy inherited by every member runtime. Defaults to `default`, never bypass. */
  permissionMode?: HadamardPermissionMode;
  permissions?: HadamardPermissionRule[];
  classifier?: HadamardToolClassifier;
  approver?: HadamardToolApprover;
  hooks?: HadamardHooks;
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
