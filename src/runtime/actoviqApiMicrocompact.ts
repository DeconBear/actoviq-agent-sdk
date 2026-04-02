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

  if (hasToolUseOrResult(messages)) {
    const trigger = compact.apiMicrocompactMaxInputTokens ?? 180_000;
    const target = compact.apiMicrocompactTargetInputTokens ?? 40_000;
    if (compact.apiMicrocompactClearToolResults !== false) {
      edits.push({
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: trigger },
        clear_at_least: { type: 'input_tokens', value: Math.max(trigger - target, 1) },
        clear_tool_inputs: ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      });
    }
    if (compact.apiMicrocompactClearToolUses) {
      edits.push({
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: trigger },
        clear_at_least: { type: 'input_tokens', value: Math.max(trigger - target, 1) },
        exclude_tools: ['Edit', 'Write', 'NotebookEdit'],
      });
    }
  }

  return edits.length > 0 ? { edits } : undefined;
}
