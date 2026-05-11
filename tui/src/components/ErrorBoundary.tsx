import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    process.stderr.write(`[ErrorBoundary] ${error.message}\n${error.stack ?? ''}\nComponent stack: ${info.componentStack ?? ''}\n`);
  }

  override render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="ansi:red">Error</Text>
          </Box>
          <Text>{this.state.error.message}</Text>
          <Box marginTop={1}>
            <Text dim>Press Ctrl+C to quit, or the UI will attempt to recover.</Text>
          </Box>
        </Box>
      );
    }
    return this.props.children;
  }
}
