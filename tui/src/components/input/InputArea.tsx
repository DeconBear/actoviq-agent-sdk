import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputAreaProps {
  onSubmit: (text: string) => void;
  onInputChange?: (value: string) => void;
  onTabComplete?: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  initialValue?: string;
}

export function InputArea({
  onSubmit,
  onInputChange,
  onTabComplete,
  streaming,
  disabled,
  placeholder,
  initialValue,
}: InputAreaProps) {
  const [value, setValue] = useState(initialValue ?? '');

  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  const handleChange = useCallback(
    (text: string) => {
      setValue(text);
      onInputChange?.(text);
    },
    [onInputChange],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue('');
      onInputChange?.('');
    },
    [onSubmit, onInputChange],
  );

  // Handle Tab: complete with first suggestion, notify parent
  const handleTab = useCallback(() => {
    onTabComplete?.();
  }, [onTabComplete]);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="cyan" bold>{'> '}</Text>
        {streaming ? (
          <Text dimColor>Waiting for response...</Text>
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
