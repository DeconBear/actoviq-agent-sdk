import React, { useState } from 'react';
import Ink from './ink/ink.js';
import Box from './ink/components/Box.js';
import Text from './ink/components/Text.js';
import ScrollBox from './ink/components/ScrollBox.js';
import { AlternateScreen } from './ink/components/AlternateScreen.js';
import useInput from './ink/hooks/use-input.js';

function TestScrollApp() {
  const [lines, setLines] = useState<string[]>([
    'Line 1: First message',
    'Line 2: Second message',
    'Line 3: Third message',
  ]);
  const [counter, setCounter] = useState(4);

  // Add a new line on Enter
  useInput((input: string, key: any) => {
    if (key.return) {
      setCounter((c) => c + 1);
      setLines((prev) => [...prev, `Line ${counter}: New message at ${new Date().toLocaleTimeString()}`]);
    }
    if (input === 'q') {
      process.exit(0);
    }
  });

  return (
    <AlternateScreen>
      <Box flexDirection="column" flexGrow={1}>
        {/* Title bar - fixed at top */}
        <Box flexShrink={0} paddingX={2} paddingY={1}>
          <Text bold color="ansi:cyan">ScrollBox Test</Text>
          <Text dim> — Press Enter to add a line, q to quit</Text>
        </Box>

        {/* Scrollable content */}
        <ScrollBox flexGrow={1} stickyScroll>
          <Box flexDirection="column" paddingX={2}>
            {lines.map((line, i) => (
              <Box key={i} paddingY={1}>
                <Text dim>{i + 1}. </Text>
                <Text>{line}</Text>
              </Box>
            ))}
          </Box>
        </ScrollBox>

        {/* Bottom status bar */}
        <Box flexShrink={0} paddingX={2} height={1}>
          <Text dim>{lines.length} lines | Press Enter to add, q to quit</Text>
        </Box>
      </Box>
    </AlternateScreen>
  );
}

const ink = new Ink({
  stdout: process.stdout,
  stdin: process.stdin,
  stderr: process.stderr,
  exitOnCtrlC: false,
  patchConsole: false,
});

ink.render(<TestScrollApp />);
