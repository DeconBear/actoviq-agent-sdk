import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentPhase } from '../../context.js';

const PHASE_PLACEHOLDERS: Record<AgentPhase, string> = {
  idle: 'Waiting for response...',
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
  const userEditedRef = useRef(false);

  useEffect(() => {
    if (initialValue !== undefined && !userEditedRef.current) {
      setValue(initialValue);
    }
  }, [initialValue]);

  const handleChange = useCallback(
    (text: string) => {
      userEditedRef.current = true;
      const filtered = suppressChar ? suppressChar(text) : text;
      setValue(filtered);
      onInputChange?.(filtered);
    },
    [onInputChange, suppressChar],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (streaming || disabled) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue('');
      userEditedRef.current = false;
      onInputChange?.('');
    },
    [onSubmit, onInputChange, streaming, disabled],
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="cyan" bold>{'> '}</Text>
        {streaming ? (
          <Text dimColor>{PHASE_PLACEHOLDERS[phase]}</Text>
        ) : disabled ? (
          <Text dimColor>No session active. Type /help for commands.</Text>
        ) : (
          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder={placeholder ?? 'Type a message (Enter to send, / for commands)...'}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
