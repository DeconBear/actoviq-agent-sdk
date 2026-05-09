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
  suppressChar?: (value: string) => string;
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
}: InputAreaProps) {
  const [value, setValue] = useState(initialValue ?? '');

  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  const handleChange = useCallback(
    (text: string) => {
      const filtered = suppressChar ? suppressChar(text) : text;
      setValue(filtered);
      onInputChange?.(filtered);
    },
    [onInputChange, suppressChar],
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
