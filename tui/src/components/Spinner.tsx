import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const VERBS = [
  'thinking', 'analyzing', 'processing', 'computing', 'reasoning',
  'evaluating', 'considering', 'planning', 'exploring', 'searching',
];

interface SpinnerProps {
  visible: boolean;
}

export function Spinner({ visible }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]!);
  const [startTime, setStartTime] = useState(0);
  const [show, setShow] = useState(false);

  // Reset startTime when spinner becomes visible
  useEffect(() => {
    if (!visible) {
      setShow(false);
      setStartTime(0);
      return;
    }
    setStartTime(Date.now());
    const timer = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(timer);
  }, [visible]);

  // Animate spinner dots
  useEffect(() => {
    if (!show) return;
    const interval = setInterval(() => setFrame((f) => (f + 1) % 4), 200);
    return () => clearInterval(interval);
  }, [show]);

  if (!show) return null;

  const dots = '.'.repeat(frame + 1);
  const elapsed = startTime > 0 ? Math.floor((Date.now() - startTime) / 1000) : 0;

  return (
    <Box marginY={1}>
      <Text color="yellow">
        {verb}{dots}
        {elapsed > 2 && <Text dimColor> ({elapsed}s)</Text>}
      </Text>
    </Box>
  );
}
