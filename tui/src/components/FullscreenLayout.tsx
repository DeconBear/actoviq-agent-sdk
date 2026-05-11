import React, { useMemo } from 'react';
import { Box, useStdout } from 'ink';

interface FullscreenLayoutProps {
  scrollable: React.ReactNode;
  bottom: React.ReactNode;
  overlay: React.ReactNode;
  modal: React.ReactNode;
}

const MIN_SCROLLABLE = 8;
const STATUS_HEIGHT = 1;
const INPUT_HEIGHT = 3;

export function FullscreenLayout({ scrollable, bottom, overlay, modal }: FullscreenLayoutProps) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const overlayRows = overlay ? 6 : 0;
  const modalRows = modal ? 5 : 0;
  const bottomReserved = modalRows + overlayRows + INPUT_HEIGHT + STATUS_HEIGHT;
  const scrollableHeight = Math.max(MIN_SCROLLABLE, termRows - bottomReserved);

  const scrollableStyle = useMemo(() => ({
    height: scrollableHeight,
    overflow: 'hidden' as const,
  }), [scrollableHeight]);

  return (
    <Box flexDirection="column" height={termRows}>
      <Box flexDirection="column" justifyContent="flex-end" {...scrollableStyle}>
        {scrollable}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {modal}
        {overlay}
        {bottom}
      </Box>
    </Box>
  );
}
