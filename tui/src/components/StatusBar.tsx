import React, { memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';

const PULSE_CHARS = ['●', '○'];

interface StatusBarProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messageCount: number;
  startedAt?: string;
}

export const StatusBar = memo(function StatusBar({
  sessionName, model, permissionMode, streaming, messageCount, startedAt,
}: StatusBarProps) {
  const [pulse, setPulse] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const startedMs = new Date(startedAt).getTime();
    const tick = () => {
      if (streaming) {
        setPulse((p) => (p + 1) % PULSE_CHARS.length);
      }
      setElapsed(Math.floor((Date.now() - startedMs) / 1000));
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [streaming, startedAt]);

  const modeColor =
    permissionMode === 'bypassPermissions' ? 'yellow' :
    permissionMode === 'acceptEdits' ? 'green' :
    permissionMode === 'plan' ? 'blue' : 'white';

  const modeLabel =
    permissionMode === 'bypassPermissions' ? 'YOLO' :
    permissionMode === 'acceptEdits' ? 'ACCEPT' :
    permissionMode === 'plan' ? 'PLAN' : 'DEFAULT';

  const fmtElapsed = elapsed >= 3600
    ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
    : elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;

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
        {streaming && <Text color="yellow">{PULSE_CHARS[pulse]}</Text>}
      </Box>
      <Box gap={1}>
        {startedAt && <Text dimColor>{fmtElapsed}</Text>}
        <Text dimColor>{messageCount} msgs</Text>
      </Box>
    </Box>
  );
});
