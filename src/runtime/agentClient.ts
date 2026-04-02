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
  ActoviqSurfacedMemory,
  CreateAgentSdkOptions,
  SessionCreateOptions,
  SessionSummary,
  StoredSession,
} from '../types.js';
import { createActoviqModelApi } from './actoviqModelApi.js';
import { AgentRunStream } from './asyncQueue.js';
import { executeConversation } from './conversationEngine.js';
import { asError, createId, deepClone, nowIso, truncateText } from './helpers.js';
import { buildRelevantMemoryMessages, extractTextFromContent } from './messageUtils.js';
import { AgentSession } from './agentSession.js';

const RELEVANT_MEMORY_SESSION_STATE_KEY = '__actoviqRelevantMemoryState';
const RELEVANT_MEMORY_MAX_SESSION_BYTES = 60 * 1024;

interface PersistedRelevantMemorySessionState {
  surfacedPaths: string[];
  totalBytes: number;
  recentTools: string[];
}

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

function getRelevantMemorySessionState(metadata: Record<string, unknown> | undefined): PersistedRelevantMemorySessionState {
  const raw = metadata?.[RELEVANT_MEMORY_SESSION_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {
      surfacedPaths: [],
      totalBytes: 0,
      recentTools: [],
    };
  }

  const state = raw as Record<string, unknown>;
  return {
    surfacedPaths: Array.isArray(state.surfacedPaths)
      ? state.surfacedPaths.filter((entry): entry is string => typeof entry === 'string')
      : [],
    totalBytes: typeof state.totalBytes === 'number' ? state.totalBytes : 0,
    recentTools: Array.isArray(state.recentTools)
      ? state.recentTools.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
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
    const memoryContext = await this.prepareRelevantMemoryContext(input);
    return this.executeRun(runId, input, options, undefined, false, undefined, memoryContext);
  }

  stream(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    const runId = createId();
    return new AgentRunStream(async (controller) => {
      try {
        const memoryContext = await this.prepareRelevantMemoryContext(input);
        const result = await this.executeRun(
          runId,
          input,
          options,
          undefined,
          true,
          controller.emit,
          memoryContext,
        );
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
    const memoryContext = await this.prepareRelevantMemoryContext(input, snapshot);
    const result = await this.executeRun(runId, input, options, snapshot, false, undefined, memoryContext);
    await this.persistSessionAfterRun(session, snapshot, input, result, options, memoryContext.surfacedMemories);
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
        const memoryContext = await this.prepareRelevantMemoryContext(input, snapshot);
        const result = await this.executeRun(
          runId,
          input,
          options,
          snapshot,
          true,
          controller.emit,
          memoryContext,
        );
        await this.persistSessionAfterRun(
          session,
          snapshot,
          input,
          result,
          options,
          memoryContext.surfacedMemories,
        );
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
    memoryContext?: {
      prefixedMessages: MessageParam[];
      surfacedMemories: ActoviqSurfacedMemory[];
    },
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
      prefixedMessages: memoryContext?.prefixedMessages,
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
    }).then(result => ({
      ...result,
      surfacedMemories: memoryContext?.surfacedMemories.length
        ? deepClone(memoryContext.surfacedMemories)
        : undefined,
    }));
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

  private async prepareRelevantMemoryContext(
    input: string | MessageParam['content'],
    session?: StoredSession,
  ): Promise<{
    prefixedMessages: MessageParam[];
    surfacedMemories: ActoviqSurfacedMemory[];
  }> {
    const promptText = typeof input === 'string' ? input : extractTextFromContent(input);
    if (!promptText.trim()) {
      return {
        prefixedMessages: [],
        surfacedMemories: [],
      };
    }

    const memoryState = await this.memory.state();
    if (!memoryState.enabled.autoMemory) {
      return {
        prefixedMessages: [],
        surfacedMemories: [],
      };
    }

    const persistedState = getRelevantMemorySessionState(session?.metadata);
    if (persistedState.totalBytes >= RELEVANT_MEMORY_MAX_SESSION_BYTES) {
      return {
        prefixedMessages: [],
        surfacedMemories: [],
      };
    }

    const surfacedMemories = await this.memory.surfaceRelevantMemories(promptText, {
      projectPath: this.config.workDir,
      sessionId: session?.id,
      alreadySurfacedPaths: persistedState.surfacedPaths,
      recentTools: persistedState.recentTools,
    });

    return {
      prefixedMessages: buildRelevantMemoryMessages(surfacedMemories),
      surfacedMemories,
    };
  }

  private async persistSessionAfterRun(
    session: AgentSession,
    snapshot: StoredSession,
    input: string | MessageParam['content'],
    result: AgentRunResult,
    options: AgentRunOptions,
    surfacedMemories: readonly ActoviqSurfacedMemory[] = [],
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
    const previousRelevantMemoryState = getRelevantMemorySessionState(next.metadata);
    const surfacedPaths = new Set(previousRelevantMemoryState.surfacedPaths);
    let totalBytes = previousRelevantMemoryState.totalBytes;
    for (const memory of surfacedMemories) {
      if (!surfacedPaths.has(memory.path)) {
        surfacedPaths.add(memory.path);
        totalBytes += memory.content.length;
      }
    }
    next.metadata[RELEVANT_MEMORY_SESSION_STATE_KEY] = {
      surfacedPaths: [...surfacedPaths],
      totalBytes,
      recentTools: [
        ...new Set(
          result.toolCalls
            .filter(call => !call.isError)
            .map(call => call.publicName),
        ),
      ],
    } satisfies PersistedRelevantMemorySessionState;
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


