import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionState } from '../../context.js';

type RiskLevel = 'low' | 'medium' | 'high';

const DESTRUCTIVE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'Shell', 'Command', 'exec', 'rm', 'mv', 'cp']);
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ls', 'cat', 'head', 'tail']);

interface PermissionDialogProps {
  state: PermissionState;
}

export function PermissionDialog({ state }: PermissionDialogProps) {
  const risk = assessRisk(state.toolName);
  const borderColor = risk === 'high' ? 'red' : risk === 'medium' ? 'yellow' : 'green';
  const riskLabel = risk === 'high' ? 'HIGH RISK' : risk === 'medium' ? 'MUTATING' : 'READ-ONLY';
  const riskColor = risk === 'high' ? 'red' : risk === 'medium' ? 'yellow' : 'green';

  const argsLines = formatArgs(state.input);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={2}
      paddingY={1}
    >
      {/* Header */}
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text color={riskColor} bold>[{riskLabel}]</Text>
        <Text bold>{state.toolName}</Text>
        {state.toolDescription && (
          <Text dimColor>{state.toolDescription.slice(0, 80)}</Text>
        )}
      </Box>

      {/* Arguments */}
      {argsLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {argsLines.slice(0, 8).map((line, i) => (
            <Text key={i} dimColor>  {line}</Text>
          ))}
          {argsLines.length > 8 && (
            <Text dimColor>  ... and {argsLines.length - 8} more lines</Text>
          )}
        </Box>
      )}

      {/* Destructive warning */}
      {risk === 'high' && (
        <Box marginTop={1}>
          <Text color="red">
            WARNING: This tool can modify your system. Review the arguments carefully.
          </Text>
        </Box>
      )}
      {risk === 'medium' && (
        <Box marginTop={1}>
          <Text color="yellow">
            This tool modifies files. Make sure the target path is correct.
          </Text>
        </Box>
      )}

      {/* Actions */}
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

function assessRisk(toolName: string): RiskLevel {
  const lower = toolName.toLowerCase();
  if (READ_ONLY_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(lower)) return 'low';
  if (DESTRUCTIVE_TOOLS.has(toolName) || DESTRUCTIVE_TOOLS.has(lower)) return 'high';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('delete') || lower.includes('rm') || lower.includes('mv')) return 'high';
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.includes('command')) return 'high';
  return 'medium';
}

function formatArgs(input: Record<string, unknown>): string[] {
  if (Object.keys(input).length === 0) return [];
  try {
    const json = JSON.stringify(input, null, 2);
    return json.split('\n');
  } catch {
    return [String(input)];
  }
}
