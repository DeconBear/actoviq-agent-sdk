import React from 'react';
import { Box, Text } from 'ink';
import type { CompletionItem } from '../hooks/useAutocomplete.js';

interface SlashCommandOverlayProps {
  suggestions: CompletionItem[];
  selectedIdx: number;
}

export function SlashCommandOverlay({ suggestions, selectedIdx }: SlashCommandOverlayProps) {
  if (suggestions.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">Commands</Text>
      </Box>

      {suggestions.map((s, i) => {
        const isSelected = i === selectedIdx;
        return (
          <Box key={s.text} flexDirection="row" gap={2} paddingX={1}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '> ' : '  '}/{s.text}
            </Text>
            {s.description && (
              <Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
                {s.description}
              </Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={1} paddingX={1}>
        <Text dimColor>
          Tab to complete, arrows to navigate, Esc to dismiss
        </Text>
      </Box>
    </Box>
  );
}
