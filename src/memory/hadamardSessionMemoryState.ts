import type { MessageParam } from '../provider/types.js';
import type {
  HadamardSessionMemoryConfig,
  HadamardSessionMemoryProgress,
  HadamardSessionMemoryRuntimeState,
} from '../types.js';
import { extractTextFromToolResultContent } from '../runtime/messageUtils.js';

export const HADAMARD_SESSION_MEMORY_STATE_KEY = '__hadamardSessionMemoryState';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createDefaultHadamardSessionMemoryRuntimeState(): HadamardSessionMemoryRuntimeState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    lastMessageCountAtExtraction: 0,
    extractionCount: 0,
    pendingPostCompaction: false,
  };
}

export function parseHadamardSessionMemoryRuntimeState(
  metadata?: Record<string, unknown>,
): HadamardSessionMemoryRuntimeState {
  const raw = metadata?.[HADAMARD_SESSION_MEMORY_STATE_KEY];
  if (!isRecord(raw)) {
    return createDefaultHadamardSessionMemoryRuntimeState();
  }

  return {
    initialized: raw.initialized === true,
    tokensAtLastExtraction:
      typeof raw.tokensAtLastExtraction === 'number' ? raw.tokensAtLastExtraction : 0,
    lastMessageCountAtExtraction:
      typeof raw.lastMessageCountAtExtraction === 'number' ? raw.lastMessageCountAtExtraction : 0,
    lastSummarizedMessageCount:
      typeof raw.lastSummarizedMessageCount === 'number'
        ? raw.lastSummarizedMessageCount
        : undefined,
    extractionCount: typeof raw.extractionCount === 'number' ? raw.extractionCount : 0,
    lastExtractionAt:
      typeof raw.lastExtractionAt === 'string' ? raw.lastExtractionAt : undefined,
    lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    pendingPostCompaction: raw.pendingPostCompaction === true,
  };
}

export function serializeHadamardSessionMemoryRuntimeState(
  state: HadamardSessionMemoryRuntimeState,
): Record<string, unknown> {
  return {
    initialized: state.initialized,
    tokensAtLastExtraction: state.tokensAtLastExtraction,
    lastMessageCountAtExtraction: state.lastMessageCountAtExtraction,
    lastSummarizedMessageCount: state.lastSummarizedMessageCount,
    extractionCount: state.extractionCount,
    lastExtractionAt: state.lastExtractionAt,
    lastAttemptAt: state.lastAttemptAt,
    lastError: state.lastError,
    pendingPostCompaction: state.pendingPostCompaction,
  };
}

export function isHadamardSystemReminderMessage(message: MessageParam): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.includes('<system-reminder>') &&
    message.content.includes('</system-reminder>')
  );
}

export function filterHadamardMessagesForSessionMemory(
  messages: readonly MessageParam[],
): MessageParam[] {
  return messages
    .filter(message => !isHadamardSystemReminderMessage(message))
    .map(message => structuredClone(message));
}

function serializeBlock(block: unknown): string {
  if (!isRecord(block)) {
    return '';
  }

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'thinking':
      return typeof block.thinking === 'string' ? block.thinking : '';
    case 'tool_use':
      return [
        typeof block.name === 'string' ? `Tool: ${block.name}` : 'Tool',
        block.input != null ? JSON.stringify(block.input) : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'tool_result':
      return extractTextFromToolResultContent(
        block.content as Parameters<typeof extractTextFromToolResultContent>[0],
      );
    case 'document':
      return isRecord(block.source) && typeof block.source.data === 'string'
        ? block.source.data
        : '';
    default:
      try {
        return JSON.stringify(block);
      } catch {
        return '';
      }
  }
}

function serializeMessage(message: MessageParam): string {
  if (typeof message.content === 'string') {
    return `${message.role}\n${message.content}`;
  }

  return `${message.role}\n${message.content.map(serializeBlock).filter(Boolean).join('\n')}`;
}

export function estimateHadamardConversationTokens(messages: readonly MessageParam[]): number {
  const serialized = messages.map(serializeMessage).filter(Boolean).join('\n\n');
  return Math.ceil(serialized.length / 4);
}

export function countHadamardToolCallsSince(
  messages: readonly MessageParam[],
  lastMessageCountAtExtraction = 0,
): number {
  const startIndex = Math.max(Math.min(lastMessageCountAtExtraction, messages.length), 0);
  let count = 0;
  for (const message of messages.slice(startIndex)) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    count += message.content.filter(
      block => isRecord(block) && block.type === 'tool_use',
    ).length;
  }
  return count;
}

export function hasHadamardToolCallsInLastAssistantTurn(
  messages: readonly MessageParam[],
): boolean {
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
    return false;
  }

  return lastAssistant.content.some(block => isRecord(block) && block.type === 'tool_use');
}

export function evaluateHadamardSessionMemoryProgress(
  messages: readonly MessageParam[],
  runtimeState: HadamardSessionMemoryRuntimeState,
  config: HadamardSessionMemoryConfig,
): HadamardSessionMemoryProgress {
  const filteredMessages = filterHadamardMessagesForSessionMemory(messages);
  const currentTokenCount = estimateHadamardConversationTokens(filteredMessages);
  const messageCountSinceLastExtraction = Math.max(
    filteredMessages.length - runtimeState.lastMessageCountAtExtraction,
    0,
  );
  const tokensSinceLastExtraction = Math.max(
    currentTokenCount - runtimeState.tokensAtLastExtraction,
    0,
  );
  const toolCallsSinceLastUpdate = countHadamardToolCallsSince(
    filteredMessages,
    runtimeState.lastMessageCountAtExtraction,
  );
  const hasToolCallsInLastTurn = hasHadamardToolCallsInLastAssistantTurn(filteredMessages);
  const meetsInitializationThreshold =
    currentTokenCount >= config.minimumMessageTokensToInit;
  const initialized = runtimeState.initialized || meetsInitializationThreshold;
  const meetsUpdateThreshold =
    tokensSinceLastExtraction >= config.minimumTokensBetweenUpdate;
  const meetsToolCallThreshold =
    toolCallsSinceLastUpdate >= config.toolCallsBetweenUpdates;
  const shouldExtract =
    initialized &&
    meetsUpdateThreshold &&
    (meetsToolCallThreshold || !hasToolCallsInLastTurn);

  return {
    currentTokenCount,
    tokensAtLastExtraction: runtimeState.tokensAtLastExtraction,
    tokensSinceLastExtraction,
    messageCountSinceLastExtraction,
    toolCallsSinceLastUpdate,
    initialized,
    meetsInitializationThreshold,
    meetsUpdateThreshold,
    meetsToolCallThreshold,
    hasToolCallsInLastTurn,
    shouldExtract,
  };
}

export function sanitizeHadamardSessionMemoryOutput(
  output: string,
  currentNotes: string,
): string {
  let normalized = output.trim();
  if (!normalized) {
    return currentNotes.trim();
  }

  if (normalized.startsWith('```')) {
    normalized = normalized.replace(/^```[a-zA-Z0-9_-]*\s*/u, '');
    normalized = normalized.replace(/\s*```$/u, '');
  }

  const headingIndex = normalized.indexOf('# Session Title');
  if (headingIndex >= 0) {
    normalized = normalized.slice(headingIndex);
  }

  normalized = normalized.trim();
  return normalized || currentNotes.trim();
}
