import React from 'react';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
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
          <Text dim>```{language}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="ansi:blackBright" paddingX={1}>
        <Text>{highlighted}</Text>
      </Box>
      <Box>
        <Text dim>```</Text>
      </Box>
    </Box>
  );
}
