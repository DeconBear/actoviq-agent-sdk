import React from 'react';
import { Box } from 'ink';

interface FullscreenLayoutProps {
  scrollable: React.ReactNode;
  bottom: React.ReactNode;
  overlay: React.ReactNode;
  modal: React.ReactNode;
}

export function FullscreenLayout({ scrollable, bottom, overlay, modal }: FullscreenLayoutProps) {
  return (
    <Box flexDirection="column" height="100%">
      {/* Scrollable content area (messages, spinner) */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {scrollable}
      </Box>

      {/* Fixed bottom area (input, permission prompts, status) */}
      <Box flexDirection="column" flexShrink={0}>
        {modal && (
          <Box flexDirection="column" flexShrink={0}>
            {modal}
          </Box>
        )}
        {overlay && (
          <Box flexDirection="column" flexShrink={0}>
            {overlay}
          </Box>
        )}
        {bottom}
      </Box>
    </Box>
  );
}
