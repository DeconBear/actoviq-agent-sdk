import React from 'react';
import { Box, Text } from 'ink';
import { highlightCode } from '../../lib/markdown.js';

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighted = highlightCode(code, language);

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      {language && (
        <Box>
          <Text dimColor>```{language}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>{highlighted}</Text>
      </Box>
      <Box>
        <Text dimColor>```</Text>
      </Box>
    </Box>
  );
}
