import type {
  ContentBlockDeltaEvent,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../provider/types.js';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ActoviqProviderApiError, ActoviqSdkError, RunAbortedError, ToolExecutionError } from '../errors.js';
import {
  getActoviqTodoSnapshot,
  formatActoviqTodoListLines,
  TODO_WRITE_TOOL_NAME,
} from '../tools/todo/TodoWriteTool.js';
import type {
  AgentEvent,
  AgentLoopCompactionRecord,
  AgentMcpServerDefinition,
  AgentRequestSummary,
  AgentRunOptions,
  AgentRunResult,
  ActoviqPermissionDecision,
  ActoviqHooks,
  AgentToolCallEventPayload,
  AgentToolCallRecord,
  AgentToolDefinition,
  ModelApi,
  ModelRequest,
  ResolvedToolExecutionResult,
  ResolvedRuntimeConfig,
  ToolCallProgress,
} from '../types.js';
import { McpConnectionManager } from '../mcp/connectionManager.js';
import { asError, deepClone, nowIso, signalAborted } from './helpers.js';
import { resolveActoviqPostSamplingHooks, resolveActoviqStopHooks } from '../hooks/actoviqHooks.js';
import {
  compactActoviqConversationIfNeeded,
  isActoviqPromptTooLongError,
} from './actoviqCompact.js';
import {
  getActoviqApiContextManagement,
  prepareActoviqProviderRequestMessages,
} from './actoviqApiMicrocompact.js';
import { decideActoviqToolPermission } from './actoviqPermissions.js';
import {
  assistantMessageToParam,
  buildUserMessage,
  extractTextFromContent,
  extractTextFromToolResultContent,
} from './messageUtils.js';

const MAX_CONCURRENT_TOOL_USES = 10;
const TODO_REMINDER_INTERVAL = 10;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

export interface ExecuteConversationOptions {
  runId: string;
  input: string | MessageParam['content'];
  messages?: MessageParam[];
  prefixedMessages?: MessageParam[];
  sessionId?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  toolChoice?: AgentRunOptions['toolChoice'];
  userId?: string;
  metadata?: Record<string, unknown>;
  effort?: AgentRunOptions['effort'];
  signal?: AbortSignal;
  permissionMode?: AgentRunOptions['permissionMode'];
  permissions?: AgentRunOptions['permissions'];
  classifier?: AgentRunOptions['classifier'];
  approver?: AgentRunOptions['approver'];
  canUseTool?: AgentRunOptions['canUseTool'];
  hooks?: ActoviqHooks;
  drainQueuedInputs?: () => string[];
  streaming: boolean;
  emit?: (event: AgentEvent) => void;
  skipRunStartedEvent?: boolean;
  modelApi: ModelApi;
  config: ResolvedRuntimeConfig;
  mcpManager: McpConnectionManager;
  /** Override the working directory for this execution (used by worktrees). */
  sessionWorkDir?: string;
}

export async function executeConversation(
  options: ExecuteConversationOptions,
): Promise<AgentRunResult> {
  const startedAt = nowIso();
  const workDir = options.sessionWorkDir ?? options.config.workDir;
  let model = options.model ?? options.config.model;
  const effort =
    options.effort === 'auto'
      ? undefined
      : options.effort ?? options.config.effort;
  const promptText =
    typeof options.input === 'string' ? options.input : extractTextFromContent(options.input);
  const postSamplingHooks = resolveActoviqPostSamplingHooks(options.hooks);
  const conversation = deepClone(options.messages ?? []);
  conversation.push(...deepClone(options.prefixedMessages ?? []));
  conversation.push(buildUserMessage(options.input));

  if (!options.skipRunStartedEvent) {
    options.emit?.({
      type: 'run.started',
      runId: options.runId,
      sessionId: options.sessionId,
      model,
      input: promptText,
      timestamp: startedAt,
    });
  }

  const resolvedTools = await options.mcpManager.resolveToolAdapters(
    options.tools ?? [],
    options.mcpServers ?? [],
  );
  const toolMap = new Map(resolvedTools.map((tool) => [tool.publicName, tool]));
  const requestSummaries: AgentRequestSummary[] = [];
  const toolCalls: AgentToolCallRecord[] = [];
  const permissionDecisions: ActoviqPermissionDecision[] = [];
  const loopCompactions: AgentLoopCompactionRecord[] = [];

  let iteration = 0;
  let finalMessage: AgentRunResult['message'] | undefined;
  let toolResults: ToolResultBlockParam[] = [];
  let consecutiveFailures = 0;
  let lastFailedTool = '';
  let maxTokensRecoveryCount = 0;
  let modelFallbackUsed = false;
  let iterationsSinceTodoWrite = 0;
  let streamInterruptionRetryIteration = 0;
  let streamInterruptionRetries = 0;
  let reactiveCompactAttempted = false;

  while (true) {
    ensureNotAborted(options.signal);
    iteration += 1;

    // In-loop auto-compact: keep a single long run within the context window
    // by summarizing old turns before each provider request. Mirrors Claude
    // Code's per-iteration autocompact and never throws.
    const loopCompact = await compactActoviqConversationIfNeeded(conversation, {
      model,
      modelApi: options.modelApi,
      compactConfig: options.config.compact,
      maxTokens: options.maxTokens ?? options.config.maxTokens,
      runKey: options.runId,
      signal: options.signal,
    });
    if (loopCompact.compacted) {
      conversation.splice(0, conversation.length, ...loopCompact.messages);
      loopCompactions.push({
        trigger: 'auto',
        iteration,
        tokenEstimateBefore: loopCompact.tokenEstimateBefore,
        tokenEstimateAfter: loopCompact.tokenEstimateAfter,
        messagesSummarized: loopCompact.messagesSummarized,
        preservedMessages: loopCompact.preservedMessages,
        clearedToolResults: loopCompact.clearedToolResults,
        summary: loopCompact.summary,
      });
      options.emit?.({
        type: 'conversation.compacted',
        runId: options.runId,
        iteration,
        trigger: 'auto',
        tokenEstimateBefore: loopCompact.tokenEstimateBefore,
        tokenEstimateAfter: loopCompact.tokenEstimateAfter,
        messagesSummarized: loopCompact.messagesSummarized,
        preservedMessages: loopCompact.preservedMessages,
        clearedToolResults: loopCompact.clearedToolResults,
        timestamp: nowIso(),
      });
    }

    const useAnthropicContextManagement = isAnthropicAPI(options.config.baseURL);
    const preparedMessages = prepareActoviqProviderRequestMessages(
      conversation,
      options.config.compact,
      { localToolResultMicrocompact: !useAnthropicContextManagement },
    );
    let localMicrocompact: AgentRequestSummary['localMicrocompact'] | undefined = preparedMessages.clearedToolResults > 0
      ? {
          enabled: true,
          clearedToolResults: preparedMessages.clearedToolResults,
          tokenEstimateBefore: preparedMessages.tokenEstimateBefore,
          tokenEstimateAfter: preparedMessages.tokenEstimateAfter,
        }
      : undefined;
    let request: ModelRequest = {
      model,
      max_tokens: options.maxTokens ?? options.config.maxTokens,
      system: options.systemPrompt ?? options.config.systemPrompt,
      temperature: options.temperature ?? options.config.temperature,
      effort,
      tools: resolvedTools.length > 0 ? resolvedTools.map((tool) => tool.providerTool) : undefined,
      tool_choice: options.toolChoice,
      metadata:
        options.userId ?? options.config.userId
          ? { user_id: options.userId ?? options.config.userId ?? null }
          : undefined,
      // Skip context_management for third-party providers — their APIs
      // may not support server-side message edits, causing undefined behavior.
      context_management: useAnthropicContextManagement
        ? getActoviqApiContextManagement(conversation, options.config.compact)
        : undefined,
      messages: deepClone(preparedMessages.messages),
      signal: options.signal,
    };
    let requestByteLength = getRequestByteLength(request);
    const maxRequestBytes = options.config.compact.apiMicrocompactMaxRequestBytes;
    if (
      !useAnthropicContextManagement &&
      maxRequestBytes &&
      requestByteLength > maxRequestBytes
    ) {
      const forcedMessages = prepareActoviqProviderRequestMessages(
        conversation,
        options.config.compact,
        { localToolResultMicrocompact: true, force: true },
      );
      const requestByteLengthBefore = requestByteLength;
      request = {
        ...request,
        messages: deepClone(forcedMessages.messages),
      };
      requestByteLength = getRequestByteLength(request);
      localMicrocompact = {
        enabled: true,
        clearedToolResults: forcedMessages.clearedToolResults,
        tokenEstimateBefore: forcedMessages.tokenEstimateBefore,
        tokenEstimateAfter: forcedMessages.tokenEstimateAfter,
        requestByteLengthBefore,
        requestByteLengthAfter: requestByteLength,
      };
    }

    // Prompt caching: a single cache breakpoint on the last message caches the
    // entire prefix (tools + system + conversation). Anthropic API hosts only.
    if (useAnthropicContextManagement && options.config.promptCachingEnabled !== false) {
      applyCacheControlToLastMessage(request.messages);
    }

    options.emit?.({
      type: 'request.started',
      runId: options.runId,
      iteration,
      requestTokenEstimate: localMicrocompact?.tokenEstimateAfter ?? preparedMessages.tokenEstimateAfter,
      requestByteLength,
      localMicrocompact,
      timestamp: nowIso(),
    });

    let message: Awaited<ReturnType<ModelApi['createMessage']>>;
    try {
      message = options.streaming
        ? await consumeStream(request, options.modelApi, iteration, options.emit, options.runId)
        : await options.modelApi.createMessage(request);
    } catch (error) {
      // Mid-stream interruptions (socket loss after response headers) never hit
      // the provider-level retry loop; retry the whole iteration here.
      if (streamInterruptionRetryIteration !== iteration) {
        streamInterruptionRetryIteration = iteration;
        streamInterruptionRetries = 0;
      }
      if (
        isRetryableStreamInterruption(error) &&
        streamInterruptionRetries < MAX_STREAM_INTERRUPTION_RETRIES
      ) {
        streamInterruptionRetries += 1;
        options.emit?.({
          type: 'request.interrupted',
          runId: options.runId,
          iteration,
          retry: streamInterruptionRetries,
          maxRetries: MAX_STREAM_INTERRUPTION_RETRIES,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        await sleep(1000 * streamInterruptionRetries);
        iteration -= 1;
        continue;
      }
      // Reactive compact: the provider rejected the request as too long even
      // though proactive estimates approved it (estimate drift, smaller real
      // context window, or oversized preserved tail). Force-compact the
      // in-flight conversation and retry this iteration, preserving mid-run
      // progress. One attempt per successful-response window, mirroring
      // Claude Code's withheld-prompt-too-long reactive compact.
      if (isActoviqPromptTooLongError(error) && !reactiveCompactAttempted) {
        reactiveCompactAttempted = true;
        const reactiveOutcome = await compactActoviqConversationIfNeeded(conversation, {
          model,
          modelApi: options.modelApi,
          compactConfig: options.config.compact,
          maxTokens: options.maxTokens ?? options.config.maxTokens,
          runKey: options.runId,
          signal: options.signal,
          force: true,
        });
        if (reactiveOutcome.compacted) {
          conversation.splice(0, conversation.length, ...reactiveOutcome.messages);
          loopCompactions.push({
            trigger: 'reactive',
            iteration,
            tokenEstimateBefore: reactiveOutcome.tokenEstimateBefore,
            tokenEstimateAfter: reactiveOutcome.tokenEstimateAfter,
            messagesSummarized: reactiveOutcome.messagesSummarized,
            preservedMessages: reactiveOutcome.preservedMessages,
            clearedToolResults: reactiveOutcome.clearedToolResults,
            summary: reactiveOutcome.summary,
          });
          options.emit?.({
            type: 'conversation.compacted',
            runId: options.runId,
            iteration,
            trigger: 'reactive',
            tokenEstimateBefore: reactiveOutcome.tokenEstimateBefore,
            tokenEstimateAfter: reactiveOutcome.tokenEstimateAfter,
            messagesSummarized: reactiveOutcome.messagesSummarized,
            preservedMessages: reactiveOutcome.preservedMessages,
            clearedToolResults: reactiveOutcome.clearedToolResults,
            timestamp: nowIso(),
          });
          iteration -= 1;
          continue;
        }
      }
      // Fallback model: after transport-level retries are exhausted, switch to
      // the configured fallback model once and retry this iteration.
      const fallbackModel = options.config.fallbackModel;
      if (
        fallbackModel &&
        !modelFallbackUsed &&
        fallbackModel !== model &&
        isModelFallbackEligibleError(error)
      ) {
        modelFallbackUsed = true;
        const fromModel = model;
        model = fallbackModel;
        options.emit?.({
          type: 'model.fallback',
          runId: options.runId,
          iteration,
          fromModel,
          toModel: fallbackModel,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        iteration -= 1;
        continue;
      }
      throw error;
    }
    streamInterruptionRetryIteration = 0;
    streamInterruptionRetries = 0;
    reactiveCompactAttempted = false;

    if (!options.streaming) {
      const text = extractTextFromContent(message.content);
      if (text) {
        options.emit?.({
          type: 'response.text.delta',
          runId: options.runId,
          iteration,
          delta: text,
          snapshot: text,
          timestamp: nowIso(),
        });
      }
    }

    finalMessage = message;
    conversation.push(assistantMessageToParam(message));

    for (const hook of postSamplingHooks) {
      await hook({
        runId: options.runId,
        sessionId: options.sessionId,
        workDir: workDir,
        iteration,
        input: options.input,
        promptText,
        options: {
          systemPrompt: options.systemPrompt,
          tools: options.tools,
          mcpServers: options.mcpServers,
          model: options.model,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          effort: options.effort,
          toolChoice: options.toolChoice,
          userId: options.userId,
          metadata: options.metadata,
          signal: options.signal,
        },
        systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
        assistantMessage: deepClone(message),
        messages: deepClone(conversation),
      });
    }

    // Run stop hooks — allow termination or error injection before tool loop
    const stopHooks = resolveActoviqStopHooks(options.hooks);
    let preventContinuation = false;
    let hookStopReason: string | undefined;
    const hookDurations: Array<{ index: number; durationMs: number }> = [];
    for (let hookIdx = 0; hookIdx < stopHooks.length; hookIdx++) {
      const stopHook = stopHooks[hookIdx]!;
      const hookStarted = Date.now();
      const result = await stopHook({
        runId: options.runId,
        sessionId: options.sessionId,
        messages: deepClone(conversation),
        assistantMessage: deepClone(message),
        systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
        stopHookActive: true,
      });
      const durationMs = Date.now() - hookStarted;
      hookDurations.push({ index: hookIdx, durationMs });
      if (result?.preventContinuation) {
        preventContinuation = true;
        hookStopReason = result.stopReason ?? hookStopReason;
      }
      if (result?.blockingErrors && result.blockingErrors.length > 0) {
        for (const err of result.blockingErrors) {
          const msg = typeof err === 'string' ? err : `${err.command ? `[${err.command}] ` : ''}${err.reason}`;
          conversation.push({
            role: 'user',
            content: `<system-reminder>\nStop hook reported blocking error: ${msg}\n</system-reminder>`,
          });
        }
      }
      if (result?.nonBlockingErrors && result.nonBlockingErrors.length > 0) {
        for (const err of result.nonBlockingErrors) {
          const msg = typeof err === 'string' ? err : `${err.command ? `[${err.command}] ` : ''}${err.reason}`;
          options.emit?.({
            type: 'response.text.delta',
            runId: options.runId,
            iteration,
            delta: `\n[stop hook warning] ${msg}`,
            snapshot: '',
            timestamp: nowIso(),
          });
        }
      }
    }

    for (const block of message.content) {
      options.emit?.({
        type: 'response.content',
        runId: options.runId,
        iteration,
        content: block,
        timestamp: nowIso(),
      });
    }

    options.emit?.({
      type: 'response.message',
      runId: options.runId,
      iteration,
      message,
      timestamp: nowIso(),
    });

    requestSummaries.push({
      iteration,
      messageId: message.id,
      model,
      stopReason: message.stop_reason ?? null,
      usage: message.usage,
      text: extractTextFromContent(message.content),
      createdAt: nowIso(),
      requestTokenEstimate: localMicrocompact?.tokenEstimateAfter ?? preparedMessages.tokenEstimateAfter,
      requestByteLength,
      localMicrocompact,
    });

    const toolUses = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');

    // max_tokens recovery: when the response was truncated mid-thought with no
    // tool calls, nudge the model to resume instead of ending the run on a
    // half-finished answer. Mirrors Claude Code's recovery loop (limit 3).
    if (
      !preventContinuation &&
      toolUses.length === 0 &&
      message.stop_reason === 'max_tokens' &&
      maxTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
    ) {
      maxTokensRecoveryCount += 1;
      conversation.push({
        role: 'user',
        content:
          'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
          'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
      });
      continue;
    }

    if (preventContinuation || toolUses.length === 0) {
      const completedAt = nowIso();
      if (!finalMessage) {
        throw new ActoviqSdkError('No final message was produced.');
      }
      return {
        runId: options.runId,
        sessionId: options.sessionId,
        model,
        text: extractTextFromContent(finalMessage.content),
        message: finalMessage,
        messages: conversation,
        stopReason: finalMessage.stop_reason ?? null,
        hookStopReason,
        usage: finalMessage.usage,
        requests: requestSummaries,
        toolCalls,
        permissionDecisions,
        ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
        startedAt,
        completedAt,
      };
    }

    if (iteration >= options.config.maxToolIterations) {
      if (toolUses.length > 0) {
        conversation.push({
          role: 'user',
          content: toolUses.map(toolUse => ({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}) before this tool could execute.`,
          })),
        });
      }
      const completedAt = nowIso();
      if (finalMessage) {
        return {
          runId: options.runId,
          sessionId: options.sessionId,
          model,
          text: extractTextFromContent(finalMessage.content),
          message: finalMessage,
          messages: conversation,
          stopReason: finalMessage.stop_reason ?? null,
          incompleteReason: `max_tool_iterations_exceeded:${options.config.maxToolIterations}`,
          maxToolIterationsExceeded: true,
          hookStopReason,
          usage: finalMessage.usage,
          requests: requestSummaries,
          toolCalls,
          permissionDecisions,
          ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
          startedAt,
          completedAt,
        };
      }
      throw new ActoviqSdkError(
        `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}).`,
      );
    }

    const runSingleToolUse = async (
      toolUse: ToolUseBlock,
    ): Promise<{ record: AgentToolCallRecord; resultBlock: ToolResultBlockParam }> => {
      ensureNotAborted(options.signal);
      const started = nowIso();
      const startedClock = Date.now();
      const adapter = toolMap.get(toolUse.name);

      const callPayload: AgentToolCallEventPayload = {
        id: toolUse.id,
        name: adapter?.sourceName ?? toolUse.name,
        publicName: toolUse.name,
        provider: adapter?.provider ?? 'local',
        mcpServerName: adapter?.mcpServerName,
        input: deepClone(toolUse.input),
        startedAt: started,
      };

      options.emit?.({
        type: 'tool.call',
        runId: options.runId,
        iteration,
        call: callPayload,
        timestamp: started,
      });

      let outputText = '';
      let output: unknown;
      let isError = false;
      let content: ToolResultBlockParam['content'] | undefined;

      try {
        if (!adapter) {
          throw new ToolExecutionError(
            toolUse.name,
            `No tool named "${toolUse.name}" is currently registered.`,
          );
        }
        const permissionDecision = await decideActoviqToolPermission({
          mode: options.permissionMode ?? 'default',
          rules: options.permissions ?? [],
          classifier: options.classifier,
          approver: options.approver,
          canUseTool: options.canUseTool,
          adapter: {
            isReadOnly: adapter.isReadOnly as ((input?: unknown) => boolean) | undefined,
            isDestructive: adapter.isDestructive as ((input?: unknown) => boolean) | undefined,
            requiresUserInteraction: adapter.requiresUserInteraction,
            checkPermissions: adapter.checkPermissions,
          },
          runId: options.runId,
          sessionId: options.sessionId,
          workDir: workDir,
          toolName: adapter.sourceName,
          publicName: toolUse.name,
          prompt: promptText,
          toolInput: toolUse.input,
          iteration,
        });
        permissionDecisions.push(permissionDecision);
        options.emit?.({
          type: 'tool.permission',
          runId: options.runId,
          iteration,
          decision: permissionDecision,
          timestamp: permissionDecision.timestamp,
        });
        if (permissionDecision.behavior === 'deny') {
          throw new ToolExecutionError(toolUse.name, permissionDecision.reason);
        }
        const onProgress: ToolCallProgress | undefined = options.emit
          ? (progress) => {
              options.emit?.({
                type: 'tool.progress',
                runId: options.runId,
                iteration,
                toolUseId: progress.toolUseID,
                data: progress.data,
                timestamp: nowIso(),
              });
            }
          : undefined;

        const execution = await adapter.execute(toolUse.input, {
          signal: options.signal,
          runId: options.runId,
          sessionId: options.sessionId,
          cwd: workDir,
          metadata: { ...(options.metadata ?? {}) },
          prompt: promptText,
          iteration,
          permissionMode: options.permissionMode,
          permissions: options.permissions,
          classifier: options.classifier,
          approver: options.approver,
          hooks: options.hooks,
          modelApi: options.modelApi,
          model,
          provider: options.config.provider,
          effort,
        }, onProgress);
        // Per-tool declared cap first (default 50k via tool factory), clamped
        // by the global artifact ceiling. MCP tools without a declared cap use
        // the global ceiling only.
        const artifactMaxChars = Math.min(
          adapter.maxResultSizeChars ?? Number.POSITIVE_INFINITY,
          options.config.compact.toolResultArtifactMaxChars ?? 80_000,
        );
        const modelFacingExecution = await artifactToolExecutionIfLarge(execution, {
          runId: options.runId,
          iteration,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          workDir: workDir,
          maxChars: artifactMaxChars,
        });
        outputText = modelFacingExecution.text;
        output = execution.rawOutput;
        isError = execution.isError ?? false;
        content = modelFacingExecution.content;
      } catch (error) {
        const normalized =
          error instanceof ToolExecutionError
            ? error
            : new ToolExecutionError(
                toolUse.name,
                asError(error).message,
                { cause: error },
              );
        outputText = normalized.message;
        output = { error: normalized.message };
        isError = true;
        content = normalized.message;
      }

      const record: AgentToolCallRecord = {
        ...callPayload,
        outputText,
        output,
        isError,
        completedAt: nowIso(),
        durationMs: Date.now() - startedClock,
      };

      return {
        record,
        resultBlock: {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content,
          is_error: isError,
        },
      };
    };

    // Execute tool batches: consecutive concurrency-safe (read-only) tools run
    // in parallel (limit 10), everything else serially. Results are recorded
    // in the original tool_use order regardless of completion order.
    for (const batch of partitionToolUsesForConcurrency(toolUses, toolMap)) {
      const outcomes =
        batch.concurrent && batch.toolUses.length > 1
          ? await runWithConcurrencyLimit(
              batch.toolUses,
              MAX_CONCURRENT_TOOL_USES,
              runSingleToolUse,
            )
          : await runSequentially(batch.toolUses, runSingleToolUse);
      for (const outcome of outcomes) {
        toolCalls.push(outcome.record);
        toolResults.push(outcome.resultBlock);
        options.emit?.({
          type: 'tool.result',
          runId: options.runId,
          iteration,
          result: outcome.record,
          timestamp: outcome.record.completedAt,
        });
      }
    }

    // Aggregate per-message budget: N parallel tools can each pass the
    // per-tool cap yet collectively flood one user message. Artifact the
    // largest results until the batch fits (mirrors Claude Code's 200k cap).
    await enforceToolResultsAggregateBudget(toolResults, {
      runId: options.runId,
      iteration,
      workDir: workDir,
      maxTotalChars: options.config.compact.toolResultsPerMessageMaxChars ?? 200_000,
      nameByToolUseId: new Map(
        toolCalls.slice(-toolUses.length).map((record) => [record.id, record.publicName]),
      ),
    });

    // Todo continuity reminder: when TodoWrite is available but unused for a
    // stretch of iterations, re-inject the current todo state so long runs
    // stay anchored to the plan (mirrors Claude Code's 10-turn reminder).
    if (toolUses.some((toolUse) => toolUse.name === TODO_WRITE_TOOL_NAME)) {
      iterationsSinceTodoWrite = 0;
    } else {
      iterationsSinceTodoWrite += 1;
      if (toolMap.has(TODO_WRITE_TOOL_NAME) && iterationsSinceTodoWrite >= TODO_REMINDER_INTERVAL) {
        const reminder = buildTodoReminderText(
          getActoviqTodoSnapshot(options.sessionId ?? options.runId),
        );
        const lastResult = toolResults.at(-1);
        if (lastResult) {
          appendTextToToolResultContent(lastResult, reminder);
          iterationsSinceTodoWrite = 0;
        }
      }
    }

    // Detect repeated tool failures to prevent retry loops
    // Only check newly added results (from this iteration)
    for (const tr of toolResults.slice(-toolUses.length)) {
      if (tr.is_error) {
        const toolName = toolCalls.find((tc) => tc.id === tr.tool_use_id)?.name;
        if (toolName && toolName === lastFailedTool) {
          consecutiveFailures += 1;
        } else {
          lastFailedTool = toolName ?? '';
          consecutiveFailures = 1;
        }
      } else {
        consecutiveFailures = 0;
        lastFailedTool = '';
      }
    }

    // Mid-run steering: user messages queued while tools were running ride in
    // the same user message as the tool results, so the model sees them on
    // the very next request (mirrors Claude Code's queued-command attachments).
    const queuedInputs = options.drainQueuedInputs?.() ?? [];

    // Always push tool results before any early return so the conversation
    // never ends with dangling tool_use blocks (which would make a persisted
    // session unusable: providers reject unpaired tool_use ids on resume).
    conversation.push({
      role: 'user',
      content: [
        ...toolResults,
        ...queuedInputs.map((text) => ({
          type: 'text' as const,
          text: `[User message sent while you were working — factor it into your current task]\n${text}`,
        })),
      ],
    });
    toolResults = [];

    if (consecutiveFailures >= 3 && lastFailedTool) {
      const completedAt = nowIso();
      if (finalMessage) {
        return {
          runId: options.runId,
          sessionId: options.sessionId,
          model,
          text: extractTextFromContent(finalMessage.content),
          message: finalMessage,
          messages: conversation,
          stopReason: finalMessage.stop_reason ?? null,
          incompleteReason: `consecutive_tool_failures:${lastFailedTool}`,
          hookStopReason,
          usage: finalMessage.usage,
          requests: requestSummaries,
          toolCalls,
          permissionDecisions,
          ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
          startedAt,
          completedAt,
        };
      }
      throw new ActoviqSdkError(
        `Tool "${lastFailedTool}" failed ${consecutiveFailures} times consecutively. Stopping to prevent retry loop.`,
      );
    }
  }
}

const ARTIFACTED_OUTPUT_MARKER = 'Tool output was large (';

async function writeToolResultArtifact(
  text: string,
  options: {
    runId: string;
    iteration: number;
    toolUseId: string;
    toolName: string;
    workDir: string;
    previewChars: number;
  },
): Promise<string> {
  const artifactDir = path.join(
    options.workDir,
    '.actoviq-artifacts',
    'tool-results',
    sanitizeArtifactSegment(options.runId),
  );
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(
    artifactDir,
    `${String(options.iteration).padStart(3, '0')}-${sanitizeArtifactSegment(options.toolUseId)}-${sanitizeArtifactSegment(options.toolName)}.txt`,
  );
  await writeFile(artifactPath, text, 'utf8');
  const preview = text.slice(0, Math.max(options.previewChars, 0));
  const omittedChars = Math.max(text.length - preview.length, 0);
  return [
    `${ARTIFACTED_OUTPUT_MARKER}${text.length} characters).`,
    `Full output saved to: ${artifactPath}`,
    omittedChars > 0 ? `Preview (${preview.length} characters, ${omittedChars} omitted):` : 'Preview:',
    preview,
  ].join('\n');
}

async function artifactToolExecutionIfLarge(
  execution: ResolvedToolExecutionResult,
  options: {
    runId: string;
    iteration: number;
    toolUseId: string;
    toolName: string;
    workDir: string;
    maxChars: number;
  },
): Promise<{ text: string; content: ToolResultBlockParam['content'] | undefined }> {
  if (options.maxChars <= 0 || execution.text.length <= options.maxChars) {
    return {
      text: execution.text,
      content: execution.content,
    };
  }

  const summary = await writeToolResultArtifact(execution.text, {
    runId: options.runId,
    iteration: options.iteration,
    toolUseId: options.toolUseId,
    toolName: options.toolName,
    workDir: options.workDir,
    previewChars: Math.min(options.maxChars, 4_000),
  });

  return {
    text: summary,
    content: summary,
  };
}

/**
 * Enforce an aggregate character budget over all tool_result blocks produced
 * in one iteration. The largest non-error, not-yet-artifacted results are
 * persisted to disk (largest first) until the batch fits the budget.
 */
async function enforceToolResultsAggregateBudget(
  toolResults: ToolResultBlockParam[],
  options: {
    runId: string;
    iteration: number;
    workDir: string;
    maxTotalChars: number;
    nameByToolUseId: Map<string, string>;
  },
): Promise<void> {
  if (options.maxTotalChars <= 0 || toolResults.length === 0) {
    return;
  }

  const measured = toolResults.map((block, index) => ({
    block,
    index,
    length: extractTextFromToolResultContent(block.content).length,
  }));
  let totalChars = measured.reduce((sum, entry) => sum + entry.length, 0);
  if (totalChars <= options.maxTotalChars) {
    return;
  }

  const candidates = measured
    .filter((entry) => {
      if (entry.block.is_error) return false;
      const text = extractTextFromToolResultContent(entry.block.content);
      return !text.startsWith(ARTIFACTED_OUTPUT_MARKER);
    })
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (totalChars <= options.maxTotalChars) {
      break;
    }
    const text = extractTextFromToolResultContent(candidate.block.content);
    if (!text) {
      continue;
    }
    const summary = await writeToolResultArtifact(text, {
      runId: options.runId,
      iteration: options.iteration,
      toolUseId: candidate.block.tool_use_id,
      toolName: options.nameByToolUseId.get(candidate.block.tool_use_id) ?? 'tool',
      workDir: options.workDir,
      previewChars: 2_000,
    });
    candidate.block.content = summary;
    totalChars = totalChars - text.length + summary.length;
  }
}

interface ToolUseBatch {
  concurrent: boolean;
  toolUses: ToolUseBlock[];
}

/**
 * Partition tool calls into batches: consecutive concurrency-safe tools are
 * grouped for parallel execution, everything else runs as a serial batch of
 * one. Mirrors Claude Code's read-only batching behavior.
 */
function partitionToolUsesForConcurrency(
  toolUses: ToolUseBlock[],
  toolMap: Map<string, { isReadOnly?: (input?: unknown) => boolean; isConcurrencySafe?: () => boolean; requiresUserInteraction?: () => boolean }>,
): ToolUseBatch[] {
  const batches: ToolUseBatch[] = [];
  for (const toolUse of toolUses) {
    const adapter = toolMap.get(toolUse.name);
    let safe = false;
    if (adapter && adapter.requiresUserInteraction?.() !== true) {
      try {
        safe = adapter.isConcurrencySafe?.() ?? adapter.isReadOnly?.(toolUse.input) ?? false;
      } catch {
        safe = false;
      }
    }
    const last = batches.at(-1);
    if (safe && last?.concurrent) {
      last.toolUses.push(toolUse);
    } else {
      batches.push({ concurrent: safe, toolUses: [toolUse] });
    }
  }
  return batches;
}

async function runSequentially<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await run(item));
  }
  return results;
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function appendTextToToolResultContent(block: ToolResultBlockParam, text: string): void {
  if (block.content === undefined || block.content === null) {
    block.content = text;
    return;
  }
  if (typeof block.content === 'string') {
    block.content = `${block.content}\n\n${text}`;
    return;
  }
  if (Array.isArray(block.content)) {
    block.content.push({ type: 'text', text });
  }
}

function buildTodoReminderText(todos: ReturnType<typeof getActoviqTodoSnapshot>): string {
  if (todos.length === 0) {
    return [
      '<system-reminder>',
      'The TodoWrite tool has not been used recently. If you are working on a multi-step task, use TodoWrite to track progress and keep exactly one item in_progress.',
      'Do not mention this reminder to the user.',
      '</system-reminder>',
    ].join('\n');
  }
  return [
    '<system-reminder>',
    'Current todo list state (re-injected for continuity):',
    formatActoviqTodoListLines(todos),
    'Continue working through pending items, update statuses with TodoWrite as you progress, and do not mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n');
}

function isModelFallbackEligibleError(error: unknown): boolean {
  if (error instanceof ActoviqProviderApiError) {
    const status = error.status ?? 0;
    return status === 429 || status === 529 || (status >= 500 && status < 600);
  }
  return false;
}

const MAX_STREAM_INTERRUPTION_RETRIES = 3;

const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
const TRANSPORT_ERROR_PATTERN =
  /terminated|fetch failed|socket|other side closed|premature|network|connection (?:closed|reset|error)/i;

/**
 * Transport-level failures that occur after the provider accepted the request
 * (mid-stream socket loss, abrupt connection close). HTTP-status errors are
 * excluded — the provider client already retried those before throwing — and
 * so are non-network errors, which must keep propagating.
 */
function isRetryableStreamInterruption(error: unknown): boolean {
  if (
    error instanceof ActoviqProviderApiError ||
    error instanceof RunAbortedError ||
    error instanceof ActoviqSdkError ||
    error instanceof ToolExecutionError
  ) {
    return false;
  }
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return false;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  if (causeCode.startsWith('UND_ERR') || TRANSPORT_ERROR_CODES.has(causeCode)) {
    return true;
  }
  const causeMessage = typeof cause?.message === 'string' ? cause.message : '';
  return TRANSPORT_ERROR_PATTERN.test(`${error.message} ${causeMessage}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mark the last content block of the last message with an ephemeral
 * cache_control breakpoint. One breakpoint caches the entire request prefix
 * (tools + system + conversation) on Anthropic API hosts. String-content
 * messages (e.g. the first user prompt) are converted to an equivalent single
 * text block so the breakpoint still applies — otherwise the whole request
 * goes uncached whenever the last message is a plain string.
 */
function applyCacheControlToLastMessage(messages: MessageParam[]): void {
  const last = messages.at(-1);
  if (!last) {
    return;
  }
  if (typeof last.content === 'string') {
    if (last.content.length === 0) {
      return;
    }
    last.content = [
      { type: 'text', text: last.content, cache_control: { type: 'ephemeral' } },
    ];
    return;
  }
  if (!Array.isArray(last.content) || last.content.length === 0) {
    return;
  }
  const lastBlock = last.content[last.content.length - 1];
  if (lastBlock && typeof lastBlock === 'object') {
    (lastBlock as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
}

function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'artifact';
}

function getRequestByteLength(request: ModelRequest): number {
  return Buffer.byteLength(JSON.stringify({
    ...request,
    signal: undefined,
  }), 'utf8');
}

async function consumeStream(
  request: ModelRequest,
  modelApi: ModelApi,
  iteration: number,
  emit: ExecuteConversationOptions['emit'],
  runId: string,
) {
  const stream = modelApi.streamMessage(request);
  let textSnapshot = '';
  for await (const event of stream) {
    if (isTextDeltaEvent(event)) {
      textSnapshot += event.delta.text;
      emit?.({
        type: 'response.text.delta',
        runId,
        iteration,
        delta: event.delta.text,
        snapshot: textSnapshot,
        timestamp: nowIso(),
      });
    }
  }
  return stream.finalMessage();
}

function isTextDeltaEvent(event: unknown): event is ContentBlockDeltaEvent & {
  delta: { type: 'text_delta'; text: string };
} {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'content_block_delta' &&
    'delta' in event &&
    typeof event.delta === 'object' &&
    event.delta !== null &&
    'type' in event.delta &&
    event.delta.type === 'text_delta' &&
    'text' in event.delta &&
    typeof event.delta.text === 'string'
  );
}

function ensureNotAborted(signal?: AbortSignal): void {
  try {
    signalAborted(signal);
  } catch (error) {
    throw new RunAbortedError(asError(error).message, { cause: error });
  }
}

function isAnthropicAPI(baseURL?: string): boolean {
  if (!baseURL) return true; // default is api.anthropic.com
  try {
    const host = new URL(baseURL).hostname;
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return true;
  }
}

