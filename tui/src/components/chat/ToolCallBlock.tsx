import React, { useState, useEffect, useRef } from 'react';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import type { ContentBlock, ToolStatus } from '../../context.js';

const SPIN_CHARS = ['◷', '◶', '◵', '◴'];

const STATUS_COLORS: Record<ToolStatus, string> = {
  pending: 'ansi:yellow',
  running: 'ansi:yellow',
  done: 'ansi:green',
  error: 'ansi:red',
};

function elapsedColor(elapsedSec: number): string {
  if (elapsedSec >= 30) return 'ansi:red';
  if (elapsedSec >= 15) return 'ansi:yellow';
  return 'ansi:yellow';
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
  const statusColor = isRunning ? elapsedColor(elapsed) : (STATUS_COLORS[toolUse.status] ?? 'ansi:white');

  const args = formatArgs(toolUse.input);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          {isRunning ? (
            <Text color={statusColor}>{SPIN_CHARS[frame]}</Text>
          ) : (
            <Text color={statusColor}>
              {toolUse.status === 'done' ? '✓' :
               toolUse.status === 'error' ? '✗' : '○'}
            </Text>
          )}
        </Box>
        <Text bold color={isRunning ? statusColor : undefined}>
          ⚡ {toolUse.name}
        </Text>
        {toolUse.provider === 'mcp' && (
          <Text dim>[mcp]</Text>
        )}
        {isRunning && toolUse.progressMessage && (
          <Text dim>— {toolUse.progressMessage}</Text>
        )}
        {isRunning && elapsed > 2 && (
          <Text dim>({elapsed}s)</Text>
        )}
        {toolUse.iteration != null && toolUse.iteration > 0 && (
          <Text dim>loop {toolUse.iteration}</Text>
        )}
      </Box>
      {args.length > 0 && !isDone && (
        <Box marginLeft={3} flexDirection="column">
          {args.map((a, i) => (
            <Text key={i} dim>
              {a.key}: {a.value}
            </Text>
          ))}
          {args.length < Object.keys(toolUse.input).length && (
            <Text dim>
              ... and {Object.keys(toolUse.input).length - args.length} more keys
            </Text>
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
