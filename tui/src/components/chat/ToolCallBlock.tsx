import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { ContentBlock, ToolStatus } from '../../context.js';

const STATUS_ICONS: Record<ToolStatus, string> = {
  pending: '○',
  running: '◐',
  done: '✓',
  error: '✗',
};

const STATUS_COLORS: Record<ToolStatus, string> = {
  pending: 'yellow',
  running: 'yellow',
  done: 'green',
  error: 'red',
};

interface ToolCallBlockProps {
  toolUse: Extract<ContentBlock, { type: 'tool_use' }>;
  live?: boolean;
}

export function ToolCallBlock({ toolUse, live }: ToolCallBlockProps) {
  const icon = STATUS_ICONS[toolUse.status] ?? '○';
  const color = STATUS_COLORS[toolUse.status] ?? 'white';
  const inputs = Object.keys(toolUse.input);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={color}>{live ? '◑' : icon}</Text>
        <Text bold>{toolUse.name}</Text>
        {inputs.length > 0 && (
          <Text dimColor>
            {inputs.slice(0, 3).map((k) => {
              const v = toolUse.input[k];
              const sv = typeof v === 'string' ? v : JSON.stringify(v);
              return sv.length > 40 ? `${k}=${sv.slice(0, 40)}...` : `${k}=${sv}`;
            }).join(' ')}
          </Text>
        )}
        <Text dimColor>[{toolUse.status}]</Text>
      </Box>
    </Box>
  );
}
