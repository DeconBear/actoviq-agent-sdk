import React, { memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';
import type { AgentPhase } from '../context.js';

const PULSE_CHARS = ['●', '○'];

const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: '',
  waiting: 'Waiting',
  generating: 'Generating',
  thinking: 'Thinking',
  'tool-calling': 'Calling tools',
  planning: 'Planning',
  'workflow-step': 'Running step',
};

const PHASE_COLORS: Record<AgentPhase, string> = {
  idle: 'white',
  waiting: 'yellow',
  generating: 'green',
  thinking: 'cyan',
  'tool-calling': 'yellow',
  planning: 'magenta',
  'workflow-step': 'magenta',
};

interface StatusBarProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messageCount: number;
  startedAt?: string;
  phase?: AgentPhase;
}

export const StatusBar = memo(function StatusBar({
  sessionName, model, permissionMode, streaming, messageCount, startedAt, phase = 'idle',
}: StatusBarProps) {
  const [pulse, setPulse] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt || !streaming) return;
    const startedMs = new Date(startedAt).getTime();
    const tick = () => {
      setPulse((p) => (p + 1) % PULSE_CHARS.length);
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

  const phaseLabel = PHASE_LABELS[phase];
  const phaseColor = PHASE_COLORS[phase];

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
        {streaming && phaseLabel && (
          <Box gap={1}>
            <Text color="yellow">{PULSE_CHARS[pulse]}</Text>
            <Text color={phaseColor}>{phaseLabel}</Text>
          </Box>
        )}
      </Box>
      <Box gap={1}>
        {startedAt && <Text dimColor>{fmtElapsed}</Text>}
        <Text dimColor>{messageCount} msgs</Text>
      </Box>
    </Box>
  );
});
