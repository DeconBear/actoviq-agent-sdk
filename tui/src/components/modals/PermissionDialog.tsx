import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionState } from '../../context.js';

interface PermissionDialogProps {
  state: PermissionState;
}

export function PermissionDialog({ state }: PermissionDialogProps) {
  const argsPreview = Object.keys(state.input).length > 0
    ? JSON.stringify(state.input, null, 2).slice(0, 200)
    : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text color="yellow" bold>Allow tool?</Text>
        <Text bold>{state.toolName}</Text>
        {state.toolDescription && (
          <Text dimColor>{state.toolDescription}</Text>
        )}
      </Box>

      {argsPreview && (
        <Box marginTop={1}>
          <Text dimColor>{argsPreview}</Text>
        </Box>
      )}

      <Box flexDirection="row" gap={2} marginTop={1}>
        <Text>
          [<Text bold color="green">y</Text>]es
        </Text>
        <Text>
          [<Text bold color="red">n</Text>]o
        </Text>
        <Text dimColor>or press Enter to deny</Text>
      </Box>
    </Box>
  );
}
