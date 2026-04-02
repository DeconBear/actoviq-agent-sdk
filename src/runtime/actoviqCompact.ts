import type { MessageParam } from '../provider/types.js';
import type {
  ActoviqCompactTrigger,
  ActoviqCompactConfig,
  ActoviqSessionCompactResult,
  ActoviqSessionMemoryRuntimeState,
  AgentSessionCompactOptions,
  ModelApi,
  ModelRequest,
  StoredSession,
} from '../types.js';
import { ActoviqProviderApiError } from '../errors.js';
import { extractTextFromContent } from './messageUtils.js';
import { nowIso } from './helpers.js';
import {
  estimateActoviqConversationTokens,
  filterActoviqMessagesForSessionMemory,
  serializeActoviqSessionMemoryRuntimeState,
} from '../memory/actoviqSessionMemoryState.js';

export const ACTOVIQ_COMPACT_STATE_KEY = '__actoviqCompactState';
export const ACTOVIQ_MICROCOMPACT_CLEARED_MESSAGE = '[Old tool result content cleared]';

interface PersistedCompactState {
  compactCount: number;
  microcompactCount: number;
  lastCompactedAt?: string;
  lastSummaryMessage?: string;
  lastTrigger?: ActoviqCompactTrigger;
}

const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt too long',
  'conversation too long',
  'context length',
  'too many input tokens',
  'input is too long',
  'request is too large',
];

export interface ActoviqCompactExecutionContext {
  workDir: string;
  systemPrompt?: string;
  model: string;
  modelApi: ModelApi;
  compactConfig: ActoviqCompactConfig;
  runtimeState: ActoviqSessionMemoryRuntimeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getPersistedActoviqCompactState(
  metadata: Record<string, unknown> | undefined,
): PersistedCompactState {
  const raw = metadata?.[ACTOVIQ_COMPACT_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {
      compactCount: 0,
      microcompactCount: 0,
    };
  }

  const state = raw as Record<string, unknown>;
  return {
    compactCount: typeof state.compactCount === 'number' ? state.compactCount : 0,
    microcompactCount: typeof state.microcompactCount === 'number' ? state.microcompactCount : 0,
    lastCompactedAt:
      typeof state.lastCompactedAt === 'string' ? state.lastCompactedAt : undefined,
    lastSummaryMessage:
      typeof state.lastSummaryMessage === 'string' ? state.lastSummaryMessage : undefined,
    lastTrigger:
      state.lastTrigger === 'auto' ||
      state.lastTrigger === 'manual' ||
      state.lastTrigger === 'reactive'
        ? state.lastTrigger
        : undefined,
  };
}

export function serializeActoviqCompactState(state: PersistedCompactState): Record<string, unknown> {
  return {
    compactCount: state.compactCount,
    microcompactCount: state.microcompactCount,
    lastCompactedAt: state.lastCompactedAt,
    lastSummaryMessage: state.lastSummaryMessage,
    lastTrigger: state.lastTrigger,
  };
}

function compactToolResultContent(
  messages: readonly MessageParam[],
  config: ActoviqCompactConfig,
): { messages: MessageParam[]; clearedCount: number } {
  const cloneMessages = (): MessageParam[] => messages.map(message => structuredClone(message));

  if (!config.microcompactEnabled) {
    return {
      messages: cloneMessages(),
      clearedCount: 0,
    };
  }

  const toolResultPositions: Array<{ messageIndex: number; blockIndex: number }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue;
    }

    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (!isRecord(block) || block.type !== 'tool_result') {
        continue;
      }
      const text = extractTextFromToolResultContent(block.content);
      if (text.length < config.microcompactMinContentChars) {
        continue;
      }
      toolResultPositions.push({ messageIndex, blockIndex });
    }
  }

  if (toolResultPositions.length <= config.microcompactKeepRecentToolResults) {
    return {
      messages: cloneMessages(),
      clearedCount: 0,
    };
  }

  const keepStart = Math.max(
    toolResultPositions.length - config.microcompactKeepRecentToolResults,
    0,
  );
  const clearPositions = toolResultPositions.slice(0, keepStart);
  const nextMessages = cloneMessages();

  for (const position of clearPositions) {
    const message = nextMessages[position.messageIndex];
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    const block = message.content[position.blockIndex];
    if (!isRecord(block) || block.type !== 'tool_result') {
      continue;
    }
    block.content = ACTOVIQ_MICROCOMPACT_CLEARED_MESSAGE;
  }

  return {
    messages: nextMessages,
    clearedCount: clearPositions.length,
  };
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(block => {
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'document' && isRecord(block.source) && typeof block.source.data === 'string') {
        return block.source.data;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildCompactSummaryPrompt(
  notes: string,
  preservedMessagesCount: number,
  summaryInstructions?: string,
): string {
  const customInstructions = summaryInstructions?.trim()
    ? `\nAdditional instructions:\n${summaryInstructions.trim()}\n`
    : '';

  return [
    'Summarize the earlier portion of this engineering conversation for future continuation.',
    'Return only the summary text.',
    'Focus on concrete state, important decisions, active tasks, files, commands, errors, and next steps.',
    `The most recent ${preservedMessagesCount} messages will be preserved verbatim outside the summary.`,
    customInstructions.trim(),
    '',
    '<conversation_to_summarize>',
    notes,
    '</conversation_to_summarize>',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPostCompactSummaryMessage(summary: string, trigger: ActoviqCompactTrigger): MessageParam {
  return {
    role: 'user',
    content: `<system-reminder>\nThis session was ${trigger === 'auto' ? 'automatically' : trigger === 'manual' ? 'manually' : 'reactively'} compacted to save context. Earlier conversation summary:\n\n${summary}\n\nContinue directly from the preserved recent messages without asking the user to repeat prior context.\n</system-reminder>`,
  };
}

function serializeMessagesForSummary(messages: readonly MessageParam[]): string {
  return messages
    .map(message => {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      return `${label}:\n${extractTextFromContent(message.content)}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function compactActoviqSession(
  session: StoredSession,
  options: AgentSessionCompactOptions & { trigger: ActoviqCompactTrigger },
  context: ActoviqCompactExecutionContext,
): Promise<{
  session: StoredSession;
  result: ActoviqSessionCompactResult;
}> {
  const persistedState = getPersistedActoviqCompactState(session.metadata);
  const filteredMessages = filterActoviqMessagesForSessionMemory(session.messages);
  const microcompacted = compactToolResultContent(filteredMessages, context.compactConfig);
  const tokenEstimateBefore = estimateActoviqConversationTokens(microcompacted.messages);

  if (!context.compactConfig.enabled) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'disabled',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  if (microcompacted.messages.length === 0) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'no_messages',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  if (!options.force && tokenEstimateBefore < context.compactConfig.autoCompactThresholdTokens) {
    if (microcompacted.clearedCount > 0) {
      const cloned = structuredClone(session);
      cloned.messages = microcompacted.messages;
      cloned.metadata[ACTOVIQ_COMPACT_STATE_KEY] = serializeActoviqCompactState({
        ...persistedState,
        microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
      });
      return {
        session: cloned,
        result: {
          compacted: false,
          trigger: options.trigger,
          reason: 'threshold_not_met',
          tokenEstimateBefore,
          tokenEstimateAfter: estimateActoviqConversationTokens(cloned.messages),
          compactCount: persistedState.compactCount,
          microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
          state: context.runtimeState,
        },
      };
    }

    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'threshold_not_met',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  const preserveRecentMessages = Math.max(
    options.preserveRecentMessages ?? context.compactConfig.preserveRecentMessages,
    1,
  );
  const preserveStart = Math.max(microcompacted.messages.length - preserveRecentMessages, 0);
  const messagesToSummarize = microcompacted.messages.slice(0, preserveStart);
  const messagesToKeep = microcompacted.messages.slice(preserveStart);

  if (messagesToSummarize.length === 0) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'threshold_not_met',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
        state: context.runtimeState,
      },
    };
  }

  const rewritePrompt = buildCompactSummaryPrompt(
    serializeMessagesForSummary(messagesToSummarize),
    messagesToKeep.length,
    options.summaryInstructions,
  );

  const request: ModelRequest = {
    model: options.model ?? context.model,
    max_tokens: options.maxTokens ?? context.compactConfig.maxSummaryTokens,
    system:
      'You are compacting a long-running engineering session. Produce a dense but concise continuation summary.',
    metadata: {
      actoviq_internal_task: 'compact',
    },
    messages: [
      {
        role: 'user',
        content: rewritePrompt,
      },
    ],
    signal: options.signal,
  };
  const response = await context.modelApi.createMessage(request);
  const summary = extractTextFromContent(response.content).trim();
  const compactedAt = nowIso();
  const nextRuntimeState: ActoviqSessionMemoryRuntimeState = {
    ...context.runtimeState,
    pendingPostCompaction: true,
  };

  const nextMessages = [buildPostCompactSummaryMessage(summary, options.trigger), ...messagesToKeep];
  const nextSession = structuredClone(session);
  nextSession.messages = nextMessages;
  nextSession.updatedAt = compactedAt;
  nextSession.metadata[ACTOVIQ_COMPACT_STATE_KEY] = serializeActoviqCompactState({
    compactCount: persistedState.compactCount + 1,
    microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
    lastCompactedAt: compactedAt,
    lastSummaryMessage: summary,
    lastTrigger: options.trigger,
  });
  nextSession.metadata.__actoviqCompactSummary = summary;
  nextSession.metadata.__actoviqCompactTrigger = options.trigger;
  nextSession.metadata.__actoviqCompactPreservedMessages = messagesToKeep.length;
  nextSession.metadata.__actoviqSessionMemoryState =
    serializeActoviqSessionMemoryRuntimeState(nextRuntimeState);

  return {
    session: nextSession,
    result: {
      compacted: true,
      trigger: options.trigger,
      reason: 'compacted',
      tokenEstimateBefore,
      tokenEstimateAfter: estimateActoviqConversationTokens(nextMessages),
      summaryMessage: summary,
      messagesRemoved: messagesToSummarize.length,
      compactCount: persistedState.compactCount + 1,
      microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
      state: nextRuntimeState,
    },
  };
}

export function isActoviqPromptTooLongError(error: unknown): boolean {
  if (error instanceof ActoviqProviderApiError) {
    if (error.status === 400 || error.status === 413) {
      const normalized = error.message.toLowerCase();
      return PROMPT_TOO_LONG_PATTERNS.some(pattern => normalized.includes(pattern));
    }
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return PROMPT_TOO_LONG_PATTERNS.some(pattern => normalized.includes(pattern));
}
