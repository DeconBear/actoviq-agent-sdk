import React from 'react';
import { Box } from 'ink';
import { FullscreenLayout } from './FullscreenLayout.js';
import { StatusBar } from './StatusBar.js';
import { Messages } from './Messages.js';
import { Spinner } from './Spinner.js';
import { InputArea } from './input/InputArea.js';
import { PermissionDialog } from './modals/PermissionDialog.js';
import type { UIMessage, ContentBlock, PermissionState, AgentPhase } from '../context.js';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';

interface MainLayoutProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messages: UIMessage[];
  streamingBlocks: ContentBlock[];
  error: string | null;
  permissionDialog: PermissionState | null;
  overlay: React.ReactNode;
  inputHistory: string[];
  onSend: (text: string) => void;
  inputValue?: string;
  onInputChange?: (value: string) => void;
  onTabComplete?: () => void;
  suppressChar?: (value: string) => string;
  startedAt?: string;
  scrollOffset?: number;
  phase?: AgentPhase;
}

export function MainLayout({
  sessionName, model, permissionMode, streaming,
  messages, streamingBlocks, error,
  permissionDialog, overlay,
  inputHistory, inputValue,
  onSend, onInputChange, onTabComplete,
  suppressChar, startedAt, scrollOffset,
  phase,
}: MainLayoutProps) {
  const scrollable = (
    <Box flexDirection="column" flexGrow={1}>
      <Messages
        messages={messages}
        streamingBlocks={streamingBlocks}
        error={error}
        scrollOffset={scrollOffset}
      />
      <Spinner visible={streaming && streamingBlocks.length === 0} phase={phase} />
    </Box>
  );

  const bottom = (
    <Box flexDirection="column">
      <InputArea
        onSubmit={onSend}
        onInputChange={onInputChange}
        onTabComplete={onTabComplete}
        streaming={streaming}
        phase={phase}
        initialValue={inputValue}
        suppressChar={suppressChar}
      />
      <StatusBar
        sessionName={sessionName}
        model={model}
        permissionMode={permissionMode}
        streaming={streaming}
        messageCount={messages.length}
        startedAt={startedAt}
        phase={phase}
      />
    </Box>
  );

  return (
    <FullscreenLayout
      scrollable={scrollable}
      bottom={bottom}
      overlay={overlay}
      modal={permissionDialog ? <PermissionDialog state={permissionDialog} /> : null}
    />
  );
}
