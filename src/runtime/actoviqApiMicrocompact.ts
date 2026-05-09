import type { MessageParam } from '../provider/types.js';
import type { ActoviqCompactConfig } from '../types.js';

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
