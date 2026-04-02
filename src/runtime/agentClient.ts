import type { MessageParam } from '../provider/types.js';

import { createActoviqBuddyApi, type ActoviqBuddyApi } from '../buddy/actoviqBuddy.js';
import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import {
  mergeActoviqHooks,
  normalizeActoviqHookMessages,
  resolveActoviqPostRunHooks,
  resolveActoviqSessionStartHooks,
} from '../hooks/actoviqHooks.js';
import { createActoviqMemoryApi, type ActoviqMemoryApi } from '../memory/actoviqMemory.js';
import {
  ACTOVIQ_SESSION_MEMORY_STATE_KEY,
  evaluateActoviqSessionMemoryProgress,
  filterActoviqMessagesForSessionMemory,
  parseActoviqSessionMemoryRuntimeState,
  sanitizeActoviqSessionMemoryOutput,
  serializeActoviqSessionMemoryRuntimeState,
} from '../memory/actoviqSessionMemoryState.js';
import { McpConnectionManager } from '../mcp/connectionManager.js';
import { BackgroundTaskStore } from '../storage/backgroundTaskStore.js';
import { SessionStore } from '../storage/sessionStore.js';
import type {
  ActoviqAgentDefinition,
  ActoviqAgentDefinitionSummary,
  ActoviqBackgroundTaskRecord,
  ActoviqAgentContinuityState,
  ActoviqCompactStateOptions,
  ActoviqDelegatedAgentRecord,
  ActoviqHooks,
  ActoviqSessionCompactResult,
  AgentMcpServerDefinition,
  AgentRunOptions,
  AgentRunResult,
  AgentSessionCompactOptions,
  AgentSessionMemoryExtractionOptions,
  AgentToolDefinition,
  ActoviqCompactState,
  ActoviqSessionMemoryExtractionResult,
  ActoviqSessionMemoryRuntimeState,
  ActoviqSurfacedMemory,
  CreateAgentSdkOptions,
  SessionCreateOptions,
  SessionSummary,
  StoredSession,
} from '../types.js';
import {
  ActoviqAgentsApi,
  createActoviqTaskTool,
  summarizeActoviqAgentDefinition,
} from './actoviqAgents.js';
import {
  ActoviqBackgroundTaskManager,
  ActoviqBackgroundTasksApi,
} from './actoviqBackgroundTasks.js';
import {
  compactActoviqSession,
  getPersistedActoviqCompactState,
  isActoviqPromptTooLongError,
} from './actoviqCompact.js';
import { createActoviqModelApi } from './actoviqModelApi.js';
import { AgentRunStream } from './asyncQueue.js';
import { executeConversation } from './conversationEngine.js';
import { asError, createId, deepClone, nowIso, truncateText } from './helpers.js';
import { buildRelevantMemoryMessages, extractTextFromContent } from './messageUtils.js';
import { AgentSession } from './agentSession.js';

const RELEVANT_MEMORY_SESSION_STATE_KEY = '__actoviqRelevantMemoryState';
const AGENT_CONTINUITY_STATE_KEY = '__actoviqAgentContinuityState';
const RELEVANT_MEMORY_MAX_SESSION_BYTES = 60 * 1024;
const DEFAULT_SESSION_MEMORY_MAX_TOKENS = 4_096;
const SESSION_MEMORY_SYSTEM_PROMPT = `You maintain the persistent session-memory markdown file for an ongoing engineering conversation.

Return only the full updated markdown document.
- Do not use code fences
- Do not add commentary before or after the markdown
- Preserve all existing section headers and italic guide lines exactly
- Update only the bodies under those sections
- Keep the notes dense, concrete, and faithful to the conversation`;

interface PersistedRelevantMemorySessionState {
  surfacedPaths: string[];
  totalBytes: number;
  recentTools: string[];
}

interface PendingDelegationRecord {
  name: string;
  description?: string;
  invokedAt: string;
}

interface SessionMemoryExtractionContext {
  model: string;
  systemPrompt?: string;
  trigger: 'auto' | 'manual';
  maxTokens?: number;
  signal?: AbortSignal;
}

interface PreparedRunAugmentations {
  hooks?: ActoviqHooks;
  prefixedMessages: MessageParam[];
  surfacedMemories: ActoviqSurfacedMemory[];
  systemPromptParts: string[];
  metadata: Record<string, unknown>;
}

interface InternalAgentRunOptions extends AgentRunOptions {
  __actoviqUseDefaultTools?: boolean;
  __actoviqUseDefaultMcpServers?: boolean;
}

interface SessionRunExecutionOutcome {
  result: AgentRunResult;
  snapshot: StoredSession;
  augmentations: PreparedRunAugmentations;
}

function cloneHooks(hooks?: ActoviqHooks): ActoviqHooks | undefined {
  if (!hooks) {
    return undefined;
  }
  return {
    sessionStart: hooks.sessionStart ? [...hooks.sessionStart] : undefined,
    postSampling: hooks.postSampling ? [...hooks.postSampling] : undefined,
    postRun: hooks.postRun ? [...hooks.postRun] : undefined,
  };
}

function cloneAgentDefinition(definition: ActoviqAgentDefinition): ActoviqAgentDefinition {
  return {
    ...definition,
    metadata: definition.metadata ? deepClone(definition.metadata) : undefined,
    hooks: cloneHooks(definition.hooks),
    tools: definition.tools ? [...definition.tools] : undefined,
    mcpServers: definition.mcpServers ? deepClone(definition.mcpServers) : undefined,
  };
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

function getAgentContinuityState(
  metadata: Record<string, unknown> | undefined,
): ActoviqAgentContinuityState {
  const raw = metadata?.[AGENT_CONTINUITY_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {
      currentAgent:
        typeof metadata?.__actoviqAgentDefinition === 'string'
          ? metadata.__actoviqAgentDefinition
          : undefined,
      delegatedAgents: [],
    };
  }

  const state = raw as Record<string, unknown>;
  return {
    currentAgent:
      typeof state.currentAgent === 'string'
        ? state.currentAgent
        : typeof metadata?.__actoviqAgentDefinition === 'string'
          ? metadata.__actoviqAgentDefinition
          : undefined,
    delegatedAgents: Array.isArray(state.delegatedAgents)
      ? state.delegatedAgents.flatMap((entry): ActoviqDelegatedAgentRecord[] => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }
          const record = entry as Record<string, unknown>;
          if (typeof record.name !== 'string' || typeof record.lastInvokedAt !== 'string') {
            return [];
          }
          return [
            {
              name: record.name,
              count: typeof record.count === 'number' ? record.count : 1,
              lastInvokedAt: record.lastInvokedAt,
              lastDescription:
                typeof record.lastDescription === 'string' ? record.lastDescription : undefined,
            },
          ];
        })
      : [],
  };
}

function mergeDelegatedAgents(
  existing: ActoviqDelegatedAgentRecord[],
  pending: PendingDelegationRecord[],
): ActoviqDelegatedAgentRecord[] {
  const merged = new Map(existing.map(record => [record.name, { ...record }]));

  for (const record of pending) {
    const current = merged.get(record.name);
    if (!current) {
      merged.set(record.name, {
        name: record.name,
        count: 1,
        lastInvokedAt: record.invokedAt,
        lastDescription: record.description,
      });
      continue;
    }

    current.count += 1;
    current.lastInvokedAt = record.invokedAt;
    current.lastDescription = record.description ?? current.lastDescription;
  }

  return [...merged.values()].sort((left, right) =>
    right.lastInvokedAt.localeCompare(left.lastInvokedAt),
  );
}

export class ActoviqAgentClient {
  readonly sessions: AgentSessionsApi;
  readonly agents: ActoviqAgentsApi;
  readonly tasks: ActoviqBackgroundTasksApi;
  readonly buddy: ActoviqBuddyApi;
  readonly memory: ActoviqMemoryApi;
  private readonly agentDefinitions: Map<string, ActoviqAgentDefinition>;
  private readonly pendingDelegations = new Map<string, PendingDelegationRecord[]>();
  private readonly backgroundTaskManager: ActoviqBackgroundTaskManager;

  private constructor(
    readonly config: Awaited<ReturnType<typeof resolveRuntimeConfig>>,
    private readonly store: SessionStore,
    private readonly backgroundTaskStore: BackgroundTaskStore,
    private readonly modelApi: NonNullable<CreateAgentSdkOptions['modelApi']>,
    private readonly mcpManager: McpConnectionManager,
    private readonly defaultTools: AgentToolDefinition[],
    private readonly defaultMcpServers: AgentMcpServerDefinition[],
    private readonly hooks?: ActoviqHooks,
    agentDefinitions: ActoviqAgentDefinition[] = [],
  ) {
    this.sessions = new AgentSessionsApi(this.store, (sessionId) => this.resumeSession(sessionId));
    this.agentDefinitions = new Map(
      agentDefinitions.map(definition => [definition.name, cloneAgentDefinition(definition)]),
    );
    this.backgroundTaskManager = new ActoviqBackgroundTaskManager(this.backgroundTaskStore);
    this.tasks = new ActoviqBackgroundTasksApi(this.backgroundTaskManager);
    this.agents = new ActoviqAgentsApi({
      listDefinitions: () => this.listAgentDefinitions(),
      getDefinition: (agent) => this.getAgentDefinition(agent),
      runDefinition: (agent, prompt, options) => this.runWithAgent(agent, prompt, options),
      launchBackgroundDefinition: (agent, prompt, options) =>
        this.launchBackgroundAgentTask(agent, prompt, options),
      createDefinitionSession: (agent, options) => this.createAgentSession(agent, options),
    });
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
    const backgroundTaskStore = new BackgroundTaskStore(config.sessionDirectory);
    const modelApi = options.modelApi ?? createActoviqModelApi(config);
    const mcpManager = new McpConnectionManager({
      name: config.clientName,
      version: config.clientVersion,
    });
    return new ActoviqAgentClient(
      config,
      store,
      backgroundTaskStore,
      modelApi,
      mcpManager,
      [...(options.tools ?? [])],
      [...(options.mcpServers ?? [])],
      options.hooks,
      options.agents ?? [],
    );
  }

  async run(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const runId = createId();
    const augmentations = await this.prepareRunAugmentations(runId, input, options);
    const result = await this.executeRun(
      runId,
      input,
      options,
      undefined,
      false,
      undefined,
      augmentations,
    );
    const hookOutcome = await this.applyPostRunHooks(runId, input, options, result);
    if (hookOutcome.sessionMetadata) {
      result.sessionHookMetadata = hookOutcome.sessionMetadata;
    }
    const delegatedAgents = mergeDelegatedAgents([], this.consumePendingDelegations(runId));
    if (delegatedAgents.length > 0) {
      result.delegatedAgents = delegatedAgents;
    }
    return result;
  }

  stream(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    const runId = createId();
    return new AgentRunStream(async (controller) => {
      try {
        const augmentations = await this.prepareRunAugmentations(runId, input, options);
        const result = await this.executeRun(
          runId,
          input,
          options,
          undefined,
          true,
          controller.emit,
          augmentations,
        );
        const hookOutcome = await this.applyPostRunHooks(runId, input, options, result);
        if (hookOutcome.sessionMetadata) {
          result.sessionHookMetadata = hookOutcome.sessionMetadata;
        }
        const delegatedAgents = mergeDelegatedAgents([], this.consumePendingDelegations(runId));
        if (delegatedAgents.length > 0) {
          result.delegatedAgents = delegatedAgents;
        }
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

  listAgentDefinitions(): ActoviqAgentDefinitionSummary[] {
    return [...this.agentDefinitions.values()].map(summarizeActoviqAgentDefinition);
  }

  getAgentDefinition(agent: string): ActoviqAgentDefinition | undefined {
    const definition = this.agentDefinitions.get(agent);
    return definition ? cloneAgentDefinition(definition) : undefined;
  }

  async runWithAgent(
    agent: string,
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const definition = this.requireAgentDefinition(agent);
    const mergedOptions = this.mergeAgentRunOptions(definition, options);
    return this.run(input, mergedOptions);
  }

  async createAgentSession(
    agent: string,
    options: SessionCreateOptions = {},
  ): Promise<AgentSession> {
    const definition = this.requireAgentDefinition(agent);
    return this.createSession({
      ...options,
      model: options.model ?? definition.model,
      systemPrompt: joinPromptParts(definition.systemPrompt, options.systemPrompt),
      metadata: {
        ...(definition.metadata ?? {}),
        ...(options.metadata ?? {}),
        __actoviqAgentDefinition: definition.name,
        [AGENT_CONTINUITY_STATE_KEY]: {
          currentAgent: definition.name,
          delegatedAgents: [],
        } satisfies ActoviqAgentContinuityState,
      },
    });
  }

  createTaskTool(options: { name?: string; description?: string } = {}): AgentToolDefinition {
    return createActoviqTaskTool({
      ...options,
      getAgentDefinition: (agent) => this.getAgentDefinition(agent),
      runAgent: (agent, prompt, runOptions) => this.runWithAgent(agent, prompt, runOptions),
      onDelegated: ({ subagentType, description, parentSessionId, parentRunId }) => {
        this.recordPendingDelegation(parentSessionId ?? parentRunId, {
          name: subagentType,
          description,
          invokedAt: nowIso(),
        });
      },
      launchBackgroundAgent: (agent, prompt, backgroundOptions) =>
        this.launchBackgroundAgentTask(agent, prompt, backgroundOptions),
    });
  }

  private hydrateSession(stored: StoredSession): AgentSession {
    return new AgentSession(
      {
        runSession: (session, input, options) => this.runOnSession(session, input, options),
        streamSession: (session, input, options) => this.streamOnSession(session, input, options),
        extractSessionMemory: (session, options) => this.extractSessionMemoryForSession(session, options),
        compactSession: (session, options) => this.compactSessionForSession(session, options),
        getCompactState: (session, options) => this.getCompactStateForSession(session, options),
        getAgentContinuity: (session) => this.getAgentContinuityForSession(session),
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
    const initialSnapshot = session.snapshot();
    const resolvedOptions = this.resolveSessionAgentOptions(initialSnapshot, options);
    const execution = await this.executeSessionRunWithReactiveCompact({
      runId,
      session,
      input,
      options: resolvedOptions,
      snapshot: initialSnapshot,
    });
    const hookOutcome = await this.applyPostRunHooks(
      runId,
      input,
      resolvedOptions,
      execution.result,
      execution.snapshot,
    );
    if (hookOutcome.sessionMetadata) {
      execution.result.sessionHookMetadata = hookOutcome.sessionMetadata;
    }
    await this.persistSessionAfterRun(
      session,
      execution.snapshot,
      input,
      execution.result,
      resolvedOptions,
      execution.augmentations.surfacedMemories,
      hookOutcome,
    );
    return execution.result;
  }

  private streamOnSession(
    session: AgentSession,
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    const runId = createId();
    const initialSnapshot = session.snapshot();

    return new AgentRunStream(async (controller) => {
      try {
        const resolvedOptions = this.resolveSessionAgentOptions(initialSnapshot, options);
        const execution = await this.executeSessionRunWithReactiveCompact({
          runId,
          session,
          input,
          options: resolvedOptions,
          snapshot: initialSnapshot,
          streaming: true,
          emit: controller.emit,
        });
        const hookOutcome = await this.applyPostRunHooks(
          runId,
          input,
          resolvedOptions,
          execution.result,
          execution.snapshot,
        );
        if (hookOutcome.sessionMetadata) {
          execution.result.sessionHookMetadata = hookOutcome.sessionMetadata;
        }
        await this.persistSessionAfterRun(
          session,
          execution.snapshot,
          input,
          execution.result,
          resolvedOptions,
          execution.augmentations.surfacedMemories,
          hookOutcome,
        );
        controller.emit({
          type: 'response.completed',
          runId,
          result: execution.result,
          timestamp: execution.result.completedAt,
        });
        return execution.result;
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
    options: InternalAgentRunOptions,
    session?: StoredSession,
    streaming = false,
    emit?: (event: import('../types.js').AgentEvent) => void,
    augmentations?: PreparedRunAugmentations,
    skipRunStartedEvent = false,
  ): Promise<AgentRunResult> {
    const metadata = {
      ...this.config.metadata,
      ...(session?.metadata ?? {}),
      ...(augmentations?.metadata ?? {}),
      ...(options.metadata ?? {}),
    };
    const systemPrompt = await this.resolveSystemPrompt(
      options,
      session,
      augmentations?.systemPromptParts,
    );

    return executeConversation({
      runId,
      input,
      messages: session?.messages,
      prefixedMessages: augmentations?.prefixedMessages,
      sessionId: session?.id,
      systemPrompt,
      tools: [
        ...(options.__actoviqUseDefaultTools === false ? [] : this.defaultTools),
        ...(options.tools ?? []),
      ],
      mcpServers: [
        ...(options.__actoviqUseDefaultMcpServers === false ? [] : this.defaultMcpServers),
        ...(options.mcpServers ?? []),
      ],
      model: options.model ?? session?.model ?? this.config.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      toolChoice: options.toolChoice,
      userId: options.userId ?? this.config.userId,
      metadata,
      signal: options.signal,
      hooks: augmentations?.hooks,
      streaming,
      emit,
      skipRunStartedEvent,
      modelApi: this.modelApi,
      config: this.config,
      mcpManager: this.mcpManager,
    }).then(result => ({
      ...result,
      surfacedMemories: augmentations?.surfacedMemories.length
        ? deepClone(augmentations.surfacedMemories)
        : undefined,
    }));
  }

  private async executeSessionRunWithReactiveCompact(args: {
    runId: string;
    session: AgentSession;
    input: string | MessageParam['content'];
    options: InternalAgentRunOptions;
    snapshot: StoredSession;
    streaming?: boolean;
    emit?: (event: import('../types.js').AgentEvent) => void;
  }): Promise<SessionRunExecutionOutcome> {
    const initialAugmentations = await this.prepareRunAugmentations(
      args.runId,
      args.input,
      args.options,
      args.snapshot,
    );

    try {
      const result = await this.executeRun(
        args.runId,
        args.input,
        args.options,
        args.snapshot,
        args.streaming ?? false,
        args.emit,
        initialAugmentations,
      );
      return {
        result,
        snapshot: args.snapshot,
        augmentations: initialAugmentations,
      };
    } catch (error) {
      if (!isActoviqPromptTooLongError(error)) {
        throw error;
      }

      const reactiveCompact = await this.tryReactiveCompactSession(
        args.session,
        args.snapshot,
        args.options,
        args.runId,
        args.emit,
      );
      if (!reactiveCompact) {
        throw error;
      }

      const retryAugmentations = await this.prepareRunAugmentations(
        args.runId,
        args.input,
        args.options,
        reactiveCompact.snapshot,
      );
      const retriedResult = await this.executeRun(
        args.runId,
        args.input,
        args.options,
        reactiveCompact.snapshot,
        args.streaming ?? false,
        args.emit,
        retryAugmentations,
        true,
      );
      retriedResult.reactiveCompact = reactiveCompact.result;
      return {
        result: retriedResult,
        snapshot: reactiveCompact.snapshot,
        augmentations: retryAugmentations,
      };
    }
  }

  private async resolveSystemPrompt(
    options: AgentRunOptions,
    session?: StoredSession,
    extraSystemPromptParts: string[] = [],
  ): Promise<string | undefined> {
    const basePrompt = options.systemPrompt ?? session?.systemPrompt ?? this.config.systemPrompt;
    const memoryState = await this.memory.state();
    const memoryPrompt = memoryState.enabled.autoMemory
      ? await this.memory.buildPromptWithEntrypoints()
      : undefined;
    const buddyPrompt = await this.buddy.getIntroText({
      userId: options.userId ?? this.config.userId,
    });
    const promptParts = [basePrompt, memoryPrompt, buddyPrompt, ...extraSystemPromptParts].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    if (promptParts.length === 0) {
      return undefined;
    }

    return promptParts.join('\n\n');
  }

  private async prepareRunAugmentations(
    runId: string,
    input: string | MessageParam['content'],
    options: AgentRunOptions,
    session?: StoredSession,
  ): Promise<PreparedRunAugmentations> {
    const promptText = typeof input === 'string' ? input : extractTextFromContent(input);
    const memoryContext = await this.prepareRelevantMemoryContext(input, session);
    const hooks = mergeActoviqHooks(this.hooks, options.hooks);
    const prefixedMessages = [...memoryContext.prefixedMessages];
    const systemPromptParts: string[] = [];
    const metadata: Record<string, unknown> = {};

    for (const hook of resolveActoviqSessionStartHooks(hooks)) {
      const result = await hook({
        runId,
        input,
        promptText,
        sessionId: session?.id,
        session: session ? deepClone(session) : undefined,
        workDir: this.config.workDir,
        options,
      });
      if (!result) {
        continue;
      }
      prefixedMessages.push(...normalizeActoviqHookMessages(result.messages));
      if (result.systemPromptParts?.length) {
        systemPromptParts.push(...result.systemPromptParts.filter(Boolean));
      }
      if (result.metadata) {
        Object.assign(metadata, result.metadata);
      }
    }

    return {
      hooks,
      prefixedMessages,
      surfacedMemories: memoryContext.surfacedMemories,
      systemPromptParts,
      metadata,
    };
  }

  private async applyPostRunHooks(
    runId: string,
    input: string | MessageParam['content'],
    options: AgentRunOptions,
    result: AgentRunResult,
    session?: StoredSession,
  ): Promise<{ sessionMetadata?: Record<string, unknown>; tags?: string[] }> {
    const promptText = typeof input === 'string' ? input : extractTextFromContent(input);
    const hooks = mergeActoviqHooks(this.hooks, options.hooks);
    const sessionMetadata: Record<string, unknown> = {};
    const tags = new Set<string>();

    for (const hook of resolveActoviqPostRunHooks(hooks)) {
      const output = await hook({
        runId,
        input,
        promptText,
        sessionId: session?.id,
        session: session ? deepClone(session) : undefined,
        workDir: this.config.workDir,
        options,
        result,
      });
      if (!output) {
        continue;
      }
      if (output.sessionMetadata) {
        Object.assign(sessionMetadata, output.sessionMetadata);
      }
      for (const tag of output.tags ?? []) {
        if (tag.trim()) {
          tags.add(tag.trim());
        }
      }
    }

    return {
      sessionMetadata: Object.keys(sessionMetadata).length > 0 ? sessionMetadata : undefined,
      tags: tags.size > 0 ? [...tags] : undefined,
    };
  }

  private recordPendingDelegation(key: string, record: PendingDelegationRecord): void {
    const existing = this.pendingDelegations.get(key) ?? [];
    existing.push(record);
    this.pendingDelegations.set(key, existing);
  }

  private consumePendingDelegations(key: string | undefined): PendingDelegationRecord[] {
    if (!key) {
      return [];
    }
    const existing = this.pendingDelegations.get(key) ?? [];
    this.pendingDelegations.delete(key);
    return existing;
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

  private getSessionMemoryRuntimeState(session?: StoredSession): ActoviqSessionMemoryRuntimeState {
    return parseActoviqSessionMemoryRuntimeState(session?.metadata);
  }

  private async getCompactStateForSession(
    session: AgentSession,
    options: Omit<ActoviqCompactStateOptions, 'projectPath' | 'runtimeState' | 'sessionId'> = {},
  ): Promise<ActoviqCompactState> {
    const snapshot = session.snapshot();
    const runtimeState = this.getSessionMemoryRuntimeState(snapshot);
    const agentContinuity = getAgentContinuityState(snapshot.metadata);
    const persistedCompactState = getPersistedActoviqCompactState(snapshot.metadata);
    const filteredMessages = filterActoviqMessagesForSessionMemory(snapshot.messages);
    const progress = evaluateActoviqSessionMemoryProgress(
      filteredMessages,
      runtimeState,
      this.memory.getSessionMemoryConfig(),
    );

    const compactState = await this.memory.compactState({
      ...options,
      sessionId: snapshot.id,
      projectPath: this.config.workDir,
      currentTokenCount: options.currentTokenCount ?? progress.currentTokenCount,
      tokensAtLastExtraction:
        options.tokensAtLastExtraction ?? progress.tokensAtLastExtraction,
      initialized: options.initialized ?? progress.initialized,
      hasToolCallsInLastTurn:
        options.hasToolCallsInLastTurn ?? progress.hasToolCallsInLastTurn,
      messageCountSinceLastExtraction:
        options.messageCountSinceLastExtraction ??
        progress.messageCountSinceLastExtraction,
      toolCallsSinceLastUpdate:
        options.toolCallsSinceLastUpdate ?? progress.toolCallsSinceLastUpdate,
      runtimeState,
    });
    return {
      ...compactState,
      compactCount: Math.max(compactState.compactCount, persistedCompactState.compactCount),
      microcompactCount: Math.max(
        compactState.microcompactCount,
        persistedCompactState.microcompactCount,
      ),
      hasCompacted:
        compactState.hasCompacted ||
        persistedCompactState.compactCount + persistedCompactState.microcompactCount > 0,
      summaryMessage: compactState.summaryMessage ?? persistedCompactState.lastSummaryMessage,
      agentContinuity,
    };
  }

  private async getAgentContinuityForSession(session: AgentSession): Promise<ActoviqAgentContinuityState> {
    return getAgentContinuityState(session.snapshot().metadata);
  }

  private async tryReactiveCompactSession(
    session: AgentSession,
    snapshot: StoredSession,
    options: InternalAgentRunOptions,
    runId: string,
    emit?: (event: import('../types.js').AgentEvent) => void,
  ): Promise<{ snapshot: StoredSession; result: ActoviqSessionCompactResult } | undefined> {
    const reactive = await compactActoviqSession(
      snapshot,
      {
        force: true,
        trigger: 'reactive',
      },
      {
        workDir: this.config.workDir,
        systemPrompt: snapshot.systemPrompt ?? this.config.systemPrompt,
        model: options.model ?? snapshot.model ?? this.config.model,
        modelApi: this.modelApi,
        compactConfig: this.config.compact,
        runtimeState: this.getSessionMemoryRuntimeState(snapshot),
      },
    );

    if (reactive.session === snapshot) {
      return undefined;
    }

    await this.store.save(reactive.session);
    session.replace(reactive.session);
    emit?.({
      type: 'session.compacted',
      runId,
      sessionId: reactive.session.id,
      trigger: reactive.result.trigger,
      result: reactive.result,
      timestamp: nowIso(),
    });
    return {
      snapshot: reactive.session,
      result: reactive.result,
    };
  }

  private async launchBackgroundAgentTask(
    agent: string,
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
  ): Promise<ActoviqBackgroundTaskRecord> {
    const definition = this.requireAgentDefinition(agent);
    const session = await this.createAgentSession(agent, {
      title: `${definition.name}: ${truncateText(prompt, 80)}`,
      metadata: {
        __actoviqBackgroundParentRunId: options.parentRunId,
        __actoviqBackgroundParentSessionId: options.parentSessionId,
      },
    });
    return this.backgroundTaskManager.launch({
      subagentType: definition.name,
      description: prompt,
      workDir: this.config.workDir,
      parentRunId: options.parentRunId,
      parentSessionId: options.parentSessionId,
      onRun: async (signal) => {
        const result = await session.send(prompt, { signal });
        return {
          runId: result.runId,
          sessionId: session.id,
          model: result.model,
          text: result.text,
          toolCallCount: result.toolCalls.length,
        };
      },
    });
  }

  private async compactSessionForSession(
    session: AgentSession,
    options: AgentSessionCompactOptions = {},
  ): Promise<ActoviqSessionCompactResult> {
    const snapshot = session.snapshot();
    const { session: compactedSession, result } = await compactActoviqSession(
      snapshot,
      {
        ...options,
        force: options.force ?? true,
        trigger: 'manual',
      },
      {
        workDir: this.config.workDir,
        systemPrompt: snapshot.systemPrompt ?? this.config.systemPrompt,
        model: snapshot.model ?? this.config.model,
        modelApi: this.modelApi,
        compactConfig: this.config.compact,
        runtimeState: this.getSessionMemoryRuntimeState(snapshot),
      },
    );

    if (compactedSession !== snapshot) {
      await this.store.save(compactedSession);
      session.replace(compactedSession);
    }

    return result;
  }

  private buildSessionMemorySystemPrompt(systemPrompt?: string): string {
    return [SESSION_MEMORY_SYSTEM_PROMPT, systemPrompt]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
  }

  private async applySessionMemoryState(
    session: AgentSession,
    stored: StoredSession,
    state: ActoviqSessionMemoryRuntimeState,
  ): Promise<void> {
    const previous = JSON.stringify(stored.metadata[ACTOVIQ_SESSION_MEMORY_STATE_KEY] ?? null);
    stored.metadata[ACTOVIQ_SESSION_MEMORY_STATE_KEY] =
      serializeActoviqSessionMemoryRuntimeState(state);
    const nextValue = JSON.stringify(stored.metadata[ACTOVIQ_SESSION_MEMORY_STATE_KEY]);
    if (previous === nextValue) {
      return;
    }
    stored.updatedAt = state.lastExtractionAt ?? state.lastAttemptAt ?? stored.updatedAt;
    await this.store.save(stored);
    session.replace(stored);
  }

  private async performSessionMemoryExtraction(
    stored: StoredSession,
    context: SessionMemoryExtractionContext & { force?: boolean },
  ): Promise<ActoviqSessionMemoryExtractionResult> {
    if (!stored.id) {
      return {
        success: false,
        skipped: true,
        updated: false,
        trigger: context.trigger,
        reason: 'missing_session_id',
        state: this.getSessionMemoryRuntimeState(stored),
      };
    }

    const memoryState = await this.memory.state({
      projectPath: this.config.workDir,
      sessionId: stored.id,
    });
    const currentState = this.getSessionMemoryRuntimeState(stored);
    const filteredMessages = filterActoviqMessagesForSessionMemory(stored.messages);

    if (!memoryState.enabled.autoCompact) {
      return {
        success: true,
        skipped: true,
        updated: false,
        trigger: context.trigger,
        reason: 'auto_compact_disabled',
        sessionId: stored.id,
        state: currentState,
      };
    }

    if (filteredMessages.length === 0) {
      return {
        success: true,
        skipped: true,
        updated: false,
        trigger: context.trigger,
        reason: 'no_messages',
        sessionId: stored.id,
        state: currentState,
      };
    }

    const progress = evaluateActoviqSessionMemoryProgress(
      filteredMessages,
      currentState,
      this.memory.getSessionMemoryConfig(),
    );
    const nextState: ActoviqSessionMemoryRuntimeState = {
      ...currentState,
      initialized: progress.initialized,
    };

    if (!context.force && !progress.shouldExtract) {
      return {
        success: true,
        skipped: true,
        updated: false,
        trigger: context.trigger,
        reason: 'threshold_not_met',
        sessionId: stored.id,
        state: nextState,
      };
    }

    const attemptTimestamp = nowIso();

    try {
      const ensured = await this.memory.ensureSessionMemory({
        projectPath: this.config.workDir,
        sessionId: stored.id,
      });
      const rewritePrompt = await this.memory.buildSessionRewritePrompt(
        ensured.content,
        ensured.path,
        {
          projectPath: this.config.workDir,
          sessionId: stored.id,
        },
      );
      const response = await this.modelApi.createMessage({
        model: context.model,
        max_tokens: context.maxTokens ?? DEFAULT_SESSION_MEMORY_MAX_TOKENS,
        system: this.buildSessionMemorySystemPrompt(context.systemPrompt),
        metadata: {
          user_id: this.config.userId ?? null,
          actoviq_internal_task: 'session_memory',
        },
        messages: [
          ...filteredMessages,
          {
            role: 'user',
            content: rewritePrompt,
          },
        ],
        signal: context.signal,
      });
      const extractedSummary = sanitizeActoviqSessionMemoryOutput(
        extractTextFromContent(response.content),
        ensured.content,
      );
      const written = await this.memory.writeSessionMemory(extractedSummary, {
        projectPath: this.config.workDir,
        sessionId: stored.id,
      });
      const extractedAt = nowIso();
      const updatedState: ActoviqSessionMemoryRuntimeState = {
        ...nextState,
        initialized: true,
        tokensAtLastExtraction: progress.currentTokenCount ?? 0,
        lastMessageCountAtExtraction: filteredMessages.length,
        lastSummarizedMessageCount:
          progress.hasToolCallsInLastTurn === true
            ? nextState.lastSummarizedMessageCount
            : filteredMessages.length,
        extractionCount: nextState.extractionCount + 1,
        lastExtractionAt: extractedAt,
        lastAttemptAt: attemptTimestamp,
        lastError: undefined,
        pendingPostCompaction: true,
      };

      return {
        success: true,
        skipped: false,
        updated: extractedSummary.trim() !== ensured.content.trim(),
        trigger: context.trigger,
        sessionId: stored.id,
        memoryPath: written.path,
        summary: written.content,
        usage: response.usage,
        state: updatedState,
      };
    } catch (error) {
      const normalized = asError(error);
      return {
        success: false,
        skipped: false,
        updated: false,
        trigger: context.trigger,
        reason: normalized.message,
        sessionId: stored.id,
        state: {
          ...nextState,
          lastAttemptAt: attemptTimestamp,
          lastError: normalized.message,
        },
      };
    }
  }

  private async extractSessionMemoryForSession(
    session: AgentSession,
    options: AgentSessionMemoryExtractionOptions = {},
  ): Promise<ActoviqSessionMemoryExtractionResult> {
    const stored = session.snapshot();
    const extraction = await this.performSessionMemoryExtraction(stored, {
      force: options.force ?? true,
      model: options.model ?? stored.model ?? this.config.model,
      systemPrompt: stored.systemPrompt ?? this.config.systemPrompt,
      trigger: 'manual',
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
    await this.applySessionMemoryState(session, stored, extraction.state);
    return extraction;
  }

  private async persistSessionAfterRun(
    session: AgentSession,
    snapshot: StoredSession,
    input: string | MessageParam['content'],
    result: AgentRunResult,
    options: AgentRunOptions,
    surfacedMemories: readonly ActoviqSurfacedMemory[] = [],
    hookOutcome: { sessionMetadata?: Record<string, unknown>; tags?: string[] } = {},
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
      ...(hookOutcome.sessionMetadata ?? {}),
    };
    const runtimeState = this.getSessionMemoryRuntimeState(next);
    if (runtimeState.pendingPostCompaction) {
      runtimeState.pendingPostCompaction = false;
      next.metadata[ACTOVIQ_SESSION_MEMORY_STATE_KEY] =
        serializeActoviqSessionMemoryRuntimeState(runtimeState);
    }
    if (hookOutcome.tags?.length) {
      next.tags = [...new Set([...next.tags, ...hookOutcome.tags])];
    }
    const pendingDelegations = this.consumePendingDelegations(snapshot.id);
    const continuityState = getAgentContinuityState(next.metadata);
    if (pendingDelegations.length > 0 || continuityState.currentAgent) {
      const delegatedAgents = mergeDelegatedAgents(
        continuityState.delegatedAgents,
        pendingDelegations,
      );
      next.metadata[AGENT_CONTINUITY_STATE_KEY] = {
        currentAgent: continuityState.currentAgent,
        delegatedAgents,
      } satisfies ActoviqAgentContinuityState;
      if (pendingDelegations.length > 0) {
        result.delegatedAgents = delegatedAgents;
      }
    }
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

    const extraction = await this.performSessionMemoryExtraction(next, {
      model: options.model ?? next.model ?? this.config.model,
      systemPrompt: next.systemPrompt ?? this.config.systemPrompt,
      trigger: 'auto',
      maxTokens: Math.min(options.maxTokens ?? this.config.maxTokens, DEFAULT_SESSION_MEMORY_MAX_TOKENS),
      signal: options.signal,
    });
    await this.applySessionMemoryState(session, next, extraction.state);

    const compacted = await compactActoviqSession(next, { trigger: 'auto' }, {
      workDir: this.config.workDir,
      systemPrompt: next.systemPrompt ?? this.config.systemPrompt,
      model: options.model ?? next.model ?? this.config.model,
      modelApi: this.modelApi,
      compactConfig: this.config.compact,
      runtimeState: extraction.state,
    });

    if (compacted.session !== next) {
      await this.store.save(compacted.session);
      session.replace(compacted.session);
    }
  }

  private requireAgentDefinition(agent: string): ActoviqAgentDefinition {
    const definition = this.agentDefinitions.get(agent);
    if (!definition) {
      throw new Error(`No agent definition named "${agent}" is registered.`);
    }
    return cloneAgentDefinition(definition);
  }

  private resolveSessionAgentOptions(
    session: StoredSession,
    options: AgentRunOptions,
  ): InternalAgentRunOptions {
    const agentName =
      typeof session.metadata.__actoviqAgentDefinition === 'string'
        ? session.metadata.__actoviqAgentDefinition
        : undefined;
    if (!agentName) {
      return options;
    }
    return this.mergeAgentRunOptions(this.requireAgentDefinition(agentName), options);
  }

  private mergeAgentRunOptions(
    definition: ActoviqAgentDefinition,
    options: AgentRunOptions,
  ): InternalAgentRunOptions {
    return {
      ...options,
      systemPrompt: joinPromptParts(definition.systemPrompt, options.systemPrompt),
      model: options.model ?? definition.model,
      metadata: {
        ...(definition.metadata ?? {}),
        ...(options.metadata ?? {}),
        __actoviqAgentDefinition: definition.name,
      },
      hooks: mergeActoviqHooks(definition.hooks, options.hooks),
      tools: [...(definition.tools ?? []), ...(options.tools ?? [])],
      mcpServers: [...(definition.mcpServers ?? []), ...(options.mcpServers ?? [])],
      __actoviqUseDefaultTools: definition.inheritDefaultTools !== false,
      __actoviqUseDefaultMcpServers: definition.inheritDefaultMcpServers !== false,
    };
  }
}

export async function createAgentSdk(
  options: CreateAgentSdkOptions = {},
): Promise<ActoviqAgentClient> {
  return ActoviqAgentClient.create(options);
}

function joinPromptParts(...parts: Array<string | undefined>): string | undefined {
  const normalized = parts.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.join('\n\n');
}


