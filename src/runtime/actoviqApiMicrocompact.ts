import type { MessageParam } from '../provider/types.js';
import type { ActoviqCompactConfig } from '../types.js';
import { estimateActoviqConversationTokens } from '../memory/actoviqSessionMemoryState.js';

const LOCAL_TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]';

export interface ActoviqProviderRequestMessagesResult {
  messages: MessageParam[];
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  clearedToolResults: number;
}

function hasToolUseOrResult(messages: readonly MessageParam[]): boolean {
  return messages.some(
    message =>
      Array.isArray(message.content) &&
      message.content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'tool_use' || block.type === 'tool_result'),
      ),
  );
}

function hasThinking(messages: readonly MessageParam[]): boolean {
  return messages.some(
    message =>
      Array.isArray(message.content) &&
      message.content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking'),
      ),
  );
}

export function getActoviqApiContextManagement(
  messages: readonly MessageParam[],
  compact: ActoviqCompactConfig,
): Record<string, unknown> | undefined {
  if (!compact.apiMicrocompactEnabled) {
    return undefined;
  }

  const edits: Record<string, unknown>[] = [];

  if (hasThinking(messages)) {
    edits.push({
      type: 'clear_thinking_20251015',
      keep: 'all',
    });
  }

  // Only emit clear_tool_uses edits when explicitly enabled.
  // Third-party proxies can mishandle these server-side edits and break
  // tool_use_id → tool_result pairing.
  if (compact.apiMicrocompactClearToolUses && hasToolUseOrResult(messages)) {
    const trigger = compact.apiMicrocompactMaxInputTokens ?? 180_000;
    const target = compact.apiMicrocompactTargetInputTokens ?? 40_000;
    edits.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: trigger },
      clear_at_least: { type: 'input_tokens', value: Math.max(trigger - target, 1) },
      exclude_tools: ['Edit', 'Write', 'NotebookEdit'],
    });
  }

  return edits.length > 0 ? { edits } : undefined;
}

export function getActoviqProviderRequestMessages(
  messages: readonly MessageParam[],
  compact: ActoviqCompactConfig,
  options: { localToolResultMicrocompact: boolean; force?: boolean },
): MessageParam[] {
  return prepareActoviqProviderRequestMessages(messages, compact, options).messages;
}

export function prepareActoviqProviderRequestMessages(
  messages: readonly MessageParam[],
  compact: ActoviqCompactConfig,
  options: { localToolResultMicrocompact: boolean; force?: boolean },
): ActoviqProviderRequestMessagesResult {
  const tokenEstimateBefore = estimateActoviqConversationTokens(messages);
  if (
    !options.localToolResultMicrocompact ||
    !compact.apiMicrocompactEnabled ||
    !compact.apiMicrocompactClearToolResults
  ) {
    const clonedMessages = [...messages];
    return {
      messages: clonedMessages,
      tokenEstimateBefore,
      tokenEstimateAfter: tokenEstimateBefore,
      clearedToolResults: 0,
    };
  }

  const trigger = compact.apiMicrocompactMaxInputTokens ?? 180_000;
  if (!options.force && tokenEstimateBefore <= trigger) {
    const clonedMessages = [...messages];
    return {
      messages: clonedMessages,
      tokenEstimateBefore,
      tokenEstimateAfter: tokenEstimateBefore,
      clearedToolResults: 0,
    };
  }

  const positions: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return;
    }
    message.content.forEach((block, blockIndex) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result' &&
        getToolResultTextLength(block) >= compact.microcompactMinContentChars
      ) {
        positions.push({ messageIndex, blockIndex });
      }
    });
  });

  const keepRecent = Math.max(compact.microcompactKeepRecentToolResults, 0);
  const clearCount = Math.max(positions.length - keepRecent, 0);
  if (clearCount === 0) {
    const clonedMessages = [...messages];
    return {
      messages: clonedMessages,
      tokenEstimateBefore,
      tokenEstimateAfter: tokenEstimateBefore,
      clearedToolResults: 0,
    };
  }

  const toClear = new Set(
    positions
      .slice(0, clearCount)
      .map(position => `${position.messageIndex}:${position.blockIndex}`),
  );

  const compactedMessages = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return { ...message };
    }
    return {
      ...message,
      content: message.content.map((block, blockIndex) => {
        if (!toClear.has(`${messageIndex}:${blockIndex}`)) {
          return block;
        }
        return {
          ...block,
          content: LOCAL_TOOL_RESULT_CLEARED_MESSAGE,
        };
      }),
    };
  });
  return {
    messages: compactedMessages,
    tokenEstimateBefore,
    tokenEstimateAfter: estimateActoviqConversationTokens(compactedMessages),
    clearedToolResults: clearCount,
  };
}

function getToolResultTextLength(block: Record<string, unknown>): number {
  const content = block.content;
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((sum, entry) => {
    if (typeof entry === 'string') {
      return sum + entry.length;
    }
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'text' in entry &&
      typeof entry.text === 'string'
    ) {
      return sum + entry.text.length;
    }
    return sum + JSON.stringify(entry).length;
  }, 0);
}
