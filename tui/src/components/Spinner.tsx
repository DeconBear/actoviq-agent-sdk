import React, { useState, useEffect } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import type { AgentPhase } from '../context.js';

const SPINNER_FRAMES = ['◷', '◶', '◵', '◴'];

const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: 'thinking',
  waiting: 'waiting',
  generating: 'generating',
  thinking: 'thinking',
  'tool-calling': 'calling tools',
  planning: 'planning',
  'workflow-step': 'running step',
};

interface SpinnerProps {
  visible: boolean;
  phase?: AgentPhase;
}

export function Spinner({ visible, phase = 'idle' }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [show, setShow] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible) {
      setShow(false);
      setStartTime(0);
      setElapsed(0);
      return;
    }
    setStartTime(Date.now());
    const timer = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (!show) return;
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 150);
    return () => clearInterval(interval);
  }, [show, startTime]);

  if (!show) return null;

  const label = PHASE_LABELS[phase];
  const frameChar = SPINNER_FRAMES[frame]!;
  const elapsedStr = elapsed > 2 ? ` (${elapsed}s)` : '';

  return (
    <Box marginY={1} paddingX={2}>
      <Text color="ansi:yellow">{frameChar} </Text>
      <Text dim>{label}...</Text>
      {elapsed > 2 && <Text dim>{elapsedStr}</Text>}
    </Box>
  );
}
