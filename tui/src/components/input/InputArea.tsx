import React, { useState, useCallback, useEffect, useRef } from 'react';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import useInput from '../../ink/hooks/use-input.js';
import type { AgentPhase } from '../../context.js';

const PHASE_PLACEHOLDERS: Record<AgentPhase, string> = {
  idle: 'Type a message (Enter to send, / for commands)...',
  waiting: 'Waiting for response...',
  generating: 'Generating response...',
  thinking: 'Thinking...',
  'tool-calling': 'Calling tools...',
  planning: 'Planning...',
  'workflow-step': 'Running workflow step...',
};

interface InputAreaProps {
  onSubmit: (text: string) => void;
  onInputChange?: (value: string) => void;
  onTabComplete?: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  initialValue?: string;
  suppressChar?: (value: string) => string;
  phase?: AgentPhase;
}

export function InputArea({
  onSubmit,
  onInputChange,
  onTabComplete,
  streaming,
  disabled,
  placeholder,
  initialValue,
  suppressChar,
  phase = 'idle',
}: InputAreaProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const [cursorPos, setCursorPos] = useState(0);
  const userEditedRef = useRef(false);

  useEffect(() => {
    if (initialValue !== undefined && !userEditedRef.current) {
      setValue(initialValue);
      setCursorPos(initialValue.length);
    }
  }, [initialValue]);

  const isActive = !streaming && !disabled;

  useInput((input: string, key: any) => {
    if (!isActive) return;

    if (key.return) {
      if (streaming || disabled) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue('');
      setCursorPos(0);
      userEditedRef.current = false;
      onInputChange?.('');
      return;
    }

    if (key.tab) {
      onTabComplete?.();
      return;
    }

    if (key.escape) {
      // Clear input on Esc
      setValue('');
      setCursorPos(0);
      onInputChange?.('');
      return;
    }

    if (key.leftArrow) {
      setCursorPos((p) => Math.max(0, p - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorPos((p) => Math.min(value.length, p + 1));
      return;
    }

    if (key.upArrow || key.downArrow) {
      // History navigation is handled by useKeyboard, don't capture
      return;
    }

    if (key.backspace || key.delete) {
      setValue((v) => {
        if (key.backspace) {
          const filtered = v.slice(0, cursorPos - 1) + v.slice(cursorPos);
          setCursorPos((p) => Math.max(0, p - 1));
          const result = suppressChar ? suppressChar(filtered) : filtered;
          onInputChange?.(result);
          userEditedRef.current = true;
          return result;
        }
        // Delete key
        const filtered = v.slice(0, cursorPos) + v.slice(cursorPos + 1);
        const result = suppressChar ? suppressChar(filtered) : filtered;
        onInputChange?.(result);
        userEditedRef.current = true;
        return result;
      });
      return;
    }

    if (key.pageUp || key.pageDown) {
      return;
    }

    // Typing
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => {
        const next = v.slice(0, cursorPos) + input + v.slice(cursorPos);
        const filtered = suppressChar ? suppressChar(next) : next;
        if (filtered !== next) return v; // suppressed
        setCursorPos((p) => p + input.length);
        userEditedRef.current = true;
        onInputChange?.(filtered);
        return filtered;
      });
    }
  }, { isActive });

  const placeholderText = placeholder ?? PHASE_PLACEHOLDERS[phase];
  const displayValue = isActive ? value : '';

  // Render cursor in the text
  const beforeCursor = displayValue.slice(0, cursorPos);
  const atCursor = displayValue[cursorPos] ?? ' ';
  const afterCursor = displayValue.slice(cursorPos + 1);

  return (
    <Box flexDirection="row" paddingX={2} paddingY={1}>
      <Box width={2} flexShrink={0}>
        <Text color="ansi:cyan" bold>{'>'}</Text>
      </Box>
      <Box flexGrow={1}>
        {isActive ? (
          <Text>
            {beforeCursor}
            <Text inverse>{atCursor === ' ' ? ' ' : atCursor}</Text>
            {afterCursor}
          </Text>
        ) : (
          <Text dim>{placeholderText}</Text>
        )}
        {isActive && value.length === 0 && (
          <Text dim>{placeholderText}</Text>
        )}
      </Box>
    </Box>
  );
}
