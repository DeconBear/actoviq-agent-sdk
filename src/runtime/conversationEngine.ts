import type {
  ContentBlockDeltaEvent,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../provider/types.js';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ActoviqSdkError, RunAbortedError, ToolExecutionError } from '../errors.js';
import type {
  AgentEvent,
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
import { compactActoviqConversationIfNeeded } from './actoviqCompact.js';
import {
  getActoviqApiContextManagement,
  prepareActoviqProviderRequestMessages,
} from './actoviqApiMicrocompact.js';
import { decideActoviqToolPermission } from './actoviqPermissions.js';
import {
  assistantMessageToParam,
  buildUserMessage,
  extractTextFromContent,
} from './messageUtils.js';

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
  signal?: AbortSignal;
  permissionMode?: AgentRunOptions['permissionMode'];
  permissions?: AgentRunOptions['permissions'];
  classifier?: AgentRunOptions['classifier'];
  approver?: AgentRunOptions['approver'];
  canUseTool?: AgentRunOptions['canUseTool'];
  hooks?: ActoviqHooks;
  streaming: boolean;
  emit?: (event: AgentEvent) => void;
  skipRunStartedEvent?: boolean;
  modelApi: ModelApi;
  config: ResolvedRuntimeConfig;
  mcpManager: McpConnectionManager;
}

export async function executeConversation(
  options: ExecuteConversationOptions,
): Promise<AgentRunResult> {
  const startedAt = nowIso();
  const model = options.model ?? options.config.model;
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

  let iteration = 0;
  let finalMessage: AgentRunResult['message'] | undefined;
  let toolResults: ToolResultBlockParam[] = [];
  let consecutiveFailures = 0;
  let lastFailedTool = '';

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
      options.emit?.({
        type: 'conversation.compacted',
        runId: options.runId,
        iteration,
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

    options.emit?.({
      type: 'request.started',
      runId: options.runId,
      iteration,
      requestTokenEstimate: localMicrocompact?.tokenEstimateAfter ?? preparedMessages.tokenEstimateAfter,
      requestByteLength,
      localMicrocompact,
      timestamp: nowIso(),
    });

    const message = options.streaming
      ? await consumeStream(request, options.modelApi, iteration, options.emit, options.runId)
      : await options.modelApi.createMessage(request);

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
        workDir: options.config.workDir,
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
          startedAt,
          completedAt,
        };
      }
      throw new ActoviqSdkError(
        `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}).`,
      );
    }

    for (const toolUse of toolUses) {
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
            requiresUserInteraction: adapter.requiresUserInteraction,
            checkPermissions: adapter.checkPermissions,
          },
          runId: options.runId,
          sessionId: options.sessionId,
          workDir: options.config.workDir,
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
          cwd: options.config.workDir,
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
        }, onProgress);
        const modelFacingExecution = await artifactToolExecutionIfLarge(execution, {
          runId: options.runId,
          iteration,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          workDir: options.config.workDir,
          maxChars: options.config.compact.toolResultArtifactMaxChars ?? 80_000,
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

      toolCalls.push(record);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content,
        is_error: isError,
      });

      options.emit?.({
        type: 'tool.result',
        runId: options.runId,
        iteration,
        result: record,
        timestamp: record.completedAt,
      });
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

    // Always push tool results before any early return so the conversation
    // never ends with dangling tool_use blocks (which would make a persisted
    // session unusable: providers reject unpaired tool_use ids on resume).
    conversation.push({
      role: 'user',
      content: toolResults,
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
  await writeFile(artifactPath, execution.text, 'utf8');
  const preview = execution.text.slice(0, Math.min(options.maxChars, 4_000));
  const omittedChars = Math.max(execution.text.length - preview.length, 0);
  const summary = [
    `Tool output was large (${execution.text.length} characters).`,
    `Full output saved to: ${artifactPath}`,
    omittedChars > 0 ? `Preview (${preview.length} characters, ${omittedChars} omitted):` : 'Preview:',
    preview,
  ].join('\n');

  return {
    text: summary,
    content: summary,
  };
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

