import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { ContentBlock, ToolStatus } from '../../context.js';

const SPIN_CHARS = ['◐', '◓', '◑', '◒'];
const VERBS = ['Running', 'Working', 'Thinking', 'Processing'];

const STATUS_COLORS: Record<ToolStatus, string> = {
  pending: 'yellow',
  running: 'yellow',
  done: 'green',
  error: 'red',
};

const STATUS_LABELS: Record<ToolStatus, string> = {
  pending: '...',
  running: '',
  done: 'done',
  error: 'error',
};

function elapsedColor(elapsedSec: number): string {
  if (elapsedSec >= 30) return 'red';
  if (elapsedSec >= 15) return 'yellowBright';
  if (elapsedSec >= 5) return 'yellow';
  return 'yellow';
}

interface ToolCallBlockProps {
  toolUse: Extract<ContentBlock, { type: 'tool_use' }>;
  live?: boolean;
}

export function ToolCallBlock({ toolUse, live }: ToolCallBlockProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (toolUse.status !== 'running') return;
    startRef.current = Date.now();
    setElapsed(0);
    setFrame(0);
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPIN_CHARS.length);
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 120);
    return () => clearInterval(timer);
  }, [toolUse.status]);

  const isRunning = toolUse.status === 'running';
  const isDone = toolUse.status === 'done' || toolUse.status === 'error';
  const runColor = isRunning ? elapsedColor(elapsed) : (STATUS_COLORS[toolUse.status] ?? 'white');

  const args = formatArgs(toolUse.input);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          {isRunning ? (
            <Text color={runColor}>{SPIN_CHARS[frame]}</Text>
          ) : (
            <Text color={runColor}>
              {toolUse.status === 'done' ? '✓' :
               toolUse.status === 'error' ? '✗' : '○'}
            </Text>
          )}
        </Box>
        <Text bold color={isRunning ? runColor : undefined}>
          {toolUse.name}
        </Text>
        {toolUse.provider === 'mcp' && (
          <Text dimColor>[mcp]</Text>
        )}
        {isDone && (
          <Text dimColor>{STATUS_LABELS[toolUse.status]}</Text>
        )}
        {isRunning && toolUse.progressMessage && (
          <Text dimColor>— {toolUse.progressMessage}</Text>
        )}
        {isRunning && elapsed > 2 && (
          <Text dimColor>({elapsed}s)</Text>
        )}
        {toolUse.iteration != null && toolUse.iteration > 0 && (
          <Text dimColor>loop {toolUse.iteration}</Text>
        )}
      </Box>
      {args.length > 0 && (
        <Box marginLeft={3} flexDirection="column">
          {args.map((a, i) => (
            <Text key={i} dimColor>  {a.key}: {a.value}</Text>
          ))}
          {args.length < Object.keys(toolUse.input).length && (
            <Text dimColor>  ... and {Object.keys(toolUse.input).length - args.length} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function formatArgs(input: Record<string, unknown>): Array<{ key: string; value: string }> {
  const entries = Object.entries(input);
  const shown = entries.slice(0, 5);

  return shown.map(([key, val]) => {
    const formatted = formatArgValue(val);
    const truncated = formatted.length > 80 ? formatted.slice(0, 80) + '...' : formatted;
    return { key, value: truncated };
  });
}

function formatArgValue(val: unknown): string {
  if (typeof val === 'string') {
    const escaped = val.length > 60 ? val.slice(0, 60) + '...' : val;
    return `"${escaped}"`;
  }
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    return `[${val.length} items]`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    if (keys.length <= 3) {
      try {
        const json = JSON.stringify(val);
        return json.length > 60 ? `{${keys.length} keys}` : json;
      } catch {
        return `{${keys.length} keys}`;
      }
    }
    return `{${keys.length} keys}`;
  }
  return String(val);
}
