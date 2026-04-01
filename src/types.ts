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





