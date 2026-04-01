import type { MessageParam } from '../provider/types.js';

import { createActoviqBuddyApi, type ActoviqBuddyApi } from '../buddy/actoviqBuddy.js';
import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import { createActoviqMemoryApi, type ActoviqMemoryApi } from '../memory/actoviqMemory.js';
import { McpConnectionManager } from '../mcp/connectionManager.js';
import { SessionStore } from '../storage/sessionStore.js';
import type {
  AgentMcpServerDefinition,
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
  CreateAgentSdkOptions,
  SessionCreateOptions,
  SessionSummary,
  StoredSession,
} from '../types.js';
import { createActoviqModelApi } from './actoviqModelApi.js';
import { AgentRunStream } from './asyncQueue.js';
import { executeConversation } from './conversationEngine.js';
import { asError, createId, deepClone, nowIso, truncateText } from './helpers.js';
import { extractTextFromContent } from './messageUtils.js';
import { AgentSession } from './agentSession.js';

export class AgentSessionsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly resumeSession: (sessionId: string) => Promise<AgentSession>,
  ) {}

  list(): Promise<SessionSummary[]> {
    return this.store.list();
  }

  get(sessionId: string): Promise<AgentSession> {
    return this.resumeSession(sessionId);
  }

  delete(sessionId: string): Promise<void> {
    return this.store.delete(sessionId);
  }
}

export class ActoviqAgentClient {
  readonly sessions: AgentSessionsApi;
  readonly buddy: ActoviqBuddyApi;
  readonly memory: ActoviqMemoryApi;

  private constructor(
    readonly config: Awaited<ReturnType<typeof resolveRuntimeConfig>>,
    private readonly store: SessionStore,
    private readonly modelApi: NonNullable<CreateAgentSdkOptions['modelApi']>,
    private readonly mcpManager: McpConnectionManager,
    private readonly defaultTools: AgentToolDefinition[],
    private readonly defaultMcpServers: AgentMcpServerDefinition[],
  ) {
    this.sessions = new AgentSessionsApi(this.store, (sessionId) => this.resumeSession(sessionId));
    this.buddy = createActoviqBuddyApi({
      homeDir: this.config.homeDir,
      userId: this.config.userId,
    });
    this.memory = createActoviqMemoryApi({
      homeDir: this.config.homeDir,
      projectPath: this.config.workDir,
    });
  }

  static async create(options: CreateAgentSdkOptions = {}): Promise<ActoviqAgentClient> {
    const config = await resolveRuntimeConfig(options);
    const store = new SessionStore(config.sessionDirectory);
    const modelApi = options.modelApi ?? createActoviqModelApi(config);
    const mcpManager = new McpConnectionManager({
      name: config.clientName,
      version: config.clientVersion,
    });
    return new ActoviqAgentClient(
      config,
      store,
      modelApi,
      mcpManager,
      [...(options.tools ?? [])],
      [...(options.mcpServers ?? [])],
    );
  }

  async run(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const runId = createId();
    return this.executeRun(runId, input, options);
  }

  stream(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    const runId = createId();
    return new AgentRunStream(async (controller) => {
      try {
        const result = await this.executeRun(runId, input, options, undefined, true, controller.emit);
        controller.emit({
          type: 'response.completed',
          runId,
          result,
          timestamp: result.completedAt,
        });
        return result;
      } catch (error) {
        const normalized = asError(error);
        controller.emit({
          type: 'error',
          runId,
          error: {
            message: normalized.message,
            code: normalized.code,
            stack: normalized.stack,
          },
          timestamp: nowIso(),
        });
        throw error;
      }
    });
  }

  async createSession(options: SessionCreateOptions = {}): Promise<AgentSession> {
    const stored = await this.store.create({
      title: options.title,
      systemPrompt: options.systemPrompt ?? this.config.systemPrompt,
      model: options.model ?? this.config.model,
      tags: options.tags,
      metadata: options.metadata,
      initialMessages: options.initialMessages,
    });
    return this.hydrateSession(stored);
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    const stored = await this.store.load(sessionId);
    return this.hydrateSession(stored);
  }

  async close(): Promise<void> {
    await this.mcpManager.closeAll();
  }

  private hydrateSession(stored: StoredSession): AgentSession {
    return new AgentSession(
      {
        runSession: (session, input, options) => this.runOnSession(session, input, options),
        streamSession: (session, input, options) => this.streamOnSession(session, input, options),
        hydrate: (next) => this.hydrateSession(next),
      },
      this.store,
      stored,
    );
  }

  private async runOnSession(
    session: AgentSession,
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const runId = createId();
    const snapshot = session.snapshot();
    const result = await this.executeRun(runId, input, options, snapshot);
    await this.persistSessionAfterRun(session, snapshot, input, result, options);
    return result;
  }

  private streamOnSession(
    session: AgentSession,
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    const runId = createId();
    const snapshot = session.snapshot();

    return new AgentRunStream(async (controller) => {
      try {
        const result = await this.executeRun(runId, input, options, snapshot, true, controller.emit);
        await this.persistSessionAfterRun(session, snapshot, input, result, options);
        controller.emit({
          type: 'response.completed',
          runId,
          result,
          timestamp: result.completedAt,
        });
        return result;
      } catch (error) {
        const normalized = asError(error);
        controller.emit({
          type: 'error',
          runId,
          error: {
            message: normalized.message,
            code: normalized.code,
            stack: normalized.stack,
          },
          timestamp: nowIso(),
        });
        throw error;
      }
    });
  }

  private async executeRun(
    runId: string,
    input: string | MessageParam['content'],
    options: AgentRunOptions,
    session?: StoredSession,
    streaming = false,
    emit?: (event: import('../types.js').AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const metadata = {
      ...this.config.metadata,
      ...(session?.metadata ?? {}),
      ...(options.metadata ?? {}),
    };
    const systemPrompt = await this.resolveSystemPrompt(options, session);

    return executeConversation({
      runId,
      input,
      messages: session?.messages,
      sessionId: session?.id,
      systemPrompt,
      tools: [...this.defaultTools, ...(options.tools ?? [])],
      mcpServers: [...this.defaultMcpServers, ...(options.mcpServers ?? [])],
      model: options.model ?? session?.model ?? this.config.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      toolChoice: options.toolChoice,
      userId: options.userId ?? this.config.userId,
      metadata,
      signal: options.signal,
      streaming,
      emit,
      modelApi: this.modelApi,
      config: this.config,
      mcpManager: this.mcpManager,
    });
  }

  private async resolveSystemPrompt(
    options: AgentRunOptions,
    session?: StoredSession,
  ): Promise<string | undefined> {
    const basePrompt = options.systemPrompt ?? session?.systemPrompt ?? this.config.systemPrompt;
    const memoryState = await this.memory.state();
    const memoryPrompt = memoryState.enabled.autoMemory
      ? await this.memory.buildPromptWithEntrypoints()
      : undefined;
    const buddyPrompt = await this.buddy.getIntroText({
      userId: options.userId ?? this.config.userId,
    });
    const promptParts = [basePrompt, memoryPrompt, buddyPrompt].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    if (promptParts.length === 0) {
      return undefined;
    }

    return promptParts.join('\n\n');
  }

  private async persistSessionAfterRun(
    session: AgentSession,
    snapshot: StoredSession,
    input: string | MessageParam['content'],
    result: AgentRunResult,
    options: AgentRunOptions,
  ): Promise<void> {
    const next = deepClone(snapshot);
    next.model = result.model;
    next.systemPrompt = options.systemPrompt ?? next.systemPrompt;
    next.messages = deepClone(result.messages);
    next.updatedAt = result.completedAt;
    next.lastRunAt = result.completedAt;
    next.metadata = {
      ...next.metadata,
      ...(options.metadata ?? {}),
    };
    next.runs.push({
      runId: result.runId,
      input: typeof input === 'string' ? input : extractTextFromContent(input),
      text: result.text,
      stopReason: result.stopReason,
      createdAt: result.startedAt,
      completedAt: result.completedAt,
      toolCallCount: result.toolCalls.length,
      usage: result.usage,
    });

    if (next.titleSource === 'auto' && next.runs.length === 1) {
      const candidate = truncateText(
        typeof input === 'string' ? input : extractTextFromContent(input),
        80,
      );
      if (candidate) {
        next.title = candidate;
      }
    }

    await this.store.save(next);
    session.replace(next);
  }
}

export async function createAgentSdk(
  options: CreateAgentSdkOptions = {},
): Promise<ActoviqAgentClient> {
  return ActoviqAgentClient.create(options);
}


