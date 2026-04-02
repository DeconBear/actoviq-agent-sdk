import type {
  ContentBlockDeltaEvent,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../provider/types.js';

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
  ResolvedRuntimeConfig,
} from '../types.js';
import { McpConnectionManager } from '../mcp/connectionManager.js';
import { asError, deepClone, nowIso, signalAborted } from './helpers.js';
import { resolveActoviqPostSamplingHooks } from '../hooks/actoviqHooks.js';
import { getActoviqApiContextManagement } from './actoviqApiMicrocompact.js';
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

  while (true) {
    ensureNotAborted(options.signal);
    iteration += 1;

    options.emit?.({
      type: 'request.started',
      runId: options.runId,
      iteration,
      timestamp: nowIso(),
    });

    const request: ModelRequest = {
      model,
      max_tokens: options.maxTokens ?? options.config.maxTokens,
      system: options.systemPrompt ?? options.config.systemPrompt,
      temperature: options.temperature ?? options.config.temperature,
      tools: resolvedTools.length > 0 ? resolvedTools.map((tool) => tool.providerTool) : undefined,
      tool_choice: resolvedTools.length > 0 ? options.toolChoice : undefined,
      metadata:
        options.userId ?? options.config.userId
          ? { user_id: options.userId ?? options.config.userId ?? null }
          : undefined,
      context_management: getActoviqApiContextManagement(conversation, options.config.compact),
      messages: deepClone(conversation),
      signal: options.signal,
    };

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
    });

    const toolUses = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    if (toolUses.length === 0) {
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
        usage: finalMessage.usage,
        requests: requestSummaries,
        toolCalls,
        permissionDecisions,
        startedAt,
        completedAt,
      };
    }

    if (iteration >= options.config.maxToolIterations) {
      throw new ActoviqSdkError(
        `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}).`,
      );
    }

    const toolResults: ToolResultBlockParam[] = [];

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
        const execution = await adapter.execute(toolUse.input, {
          signal: options.signal,
          runId: options.runId,
          sessionId: options.sessionId,
          cwd: options.config.workDir,
          metadata: { ...(options.metadata ?? {}) },
          prompt: promptText,
          iteration,
        });
        outputText = execution.text;
        output = execution.rawOutput;
        isError = execution.isError ?? false;
        content = execution.content;
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

    conversation.push({
      role: 'user',
      content: toolResults,
    });
  }
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

