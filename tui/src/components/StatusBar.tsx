import React, { memo, useState, useEffect, useRef } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';
import type { AgentPhase } from '../context.js';

const SPINNER = ['◷', '◶', '◵', '◴'];

const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: '',
  waiting: 'Waiting',
  generating: 'Generating',
  thinking: 'Thinking',
  'tool-calling': 'Calling tools',
  planning: 'Planning',
  'workflow-step': 'Running step',
};

interface StatusBarProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messageCount: number;
  startedAt?: string;
  phase?: AgentPhase;
  contextPct?: number;
}

export const StatusBar = memo(function StatusBar({
  sessionName, model, permissionMode, streaming, messageCount, startedAt, phase = 'idle', contextPct,
}: StatusBarProps) {
  const [spinIdx, setSpinIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedMsRef = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt) {
      startedMsRef.current = new Date(startedAt).getTime();
    }
    if (!startedAt || !streaming) {
      startedMsRef.current = null;
      return;
    }
    const tick = () => {
      if (startedMsRef.current == null) return;
      setSpinIdx((p) => (p + 1) % SPINNER.length);
      setElapsed(Math.floor((Date.now() - startedMsRef.current) / 1000));
    };
    tick();
    const timer = setInterval(tick, 150);
    return () => clearInterval(timer);
  }, [streaming, startedAt]);

  const modeColor =
    permissionMode === 'bypassPermissions' ? 'ansi:yellow' :
    permissionMode === 'acceptEdits' ? 'ansi:green' :
    permissionMode === 'plan' ? 'ansi:blue' : 'ansi:white';

  const modeLabel =
    permissionMode === 'bypassPermissions' ? 'YOLO' :
    permissionMode === 'acceptEdits' ? 'ACCEPT' :
    permissionMode === 'plan' ? 'PLAN' : 'DEFAULT';

  const fmtElapsed = elapsed >= 3600
    ? `${Math.floor(elapsed / 3600)}h${Math.floor((elapsed % 3600) / 60)}m`
    : elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
      : `${elapsed}s`;

  const phaseLabel = PHASE_LABELS[phase];
  const phaseSpin = SPINNER[spinIdx]!;

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={2} height={1}>
      <Box gap={1}>
        <Text bold>{sessionName}</Text>
        <Text dim>|</Text>
        <Text dim>{model}</Text>
        {contextPct != null && (
          <Box gap={1}>
            <Text dim>|</Text>
            <Text dim>{contextPct}% ctx</Text>
          </Box>
        )}
        <Text dim>|</Text>
        <Text color={modeColor}>{modeLabel}</Text>
        {streaming && phaseLabel && (
          <Box gap={1}>
            <Text dim>|</Text>
            <Text color="ansi:yellow">{phaseSpin} {phaseLabel}</Text>
            {startedAt && <Text dim>{fmtElapsed}</Text>}
          </Box>
        )}
      </Box>
      <Box gap={1}>
        <Text dim>{messageCount} msgs</Text>
      </Box>
    </Box>
  );
});
