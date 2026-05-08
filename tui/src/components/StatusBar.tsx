import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';

interface StatusBarProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messageCount: number;
}

export const StatusBar = memo(function StatusBar({
  sessionName, model, permissionMode, streaming, messageCount,
}: StatusBarProps) {
  const modeColor =
    permissionMode === 'bypassPermissions' ? 'yellow' :
    permissionMode === 'acceptEdits' ? 'green' :
    permissionMode === 'plan' ? 'blue' : 'white';

  const modeLabel =
    permissionMode === 'bypassPermissions' ? 'BYPASS' :
    permissionMode === 'acceptEdits' ? 'ACCEPT' :
    permissionMode === 'plan' ? 'PLAN' : 'DEFAULT';

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
    >
      <Box gap={1}>
        <Text bold>{sessionName || 'actoviq'}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{model}</Text>
        <Text dimColor>|</Text>
        <Text color={modeColor}>{modeLabel}</Text>
        {streaming && <Text color="yellow"> ●</Text>}
      </Box>
      <Box gap={1}>
        <Text dimColor>{messageCount} msgs</Text>
      </Box>
    </Box>
  );
});
