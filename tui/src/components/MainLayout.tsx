import React from 'react';
import { Box } from 'ink';
import { FullscreenLayout } from './FullscreenLayout.js';
import { StatusBar } from './StatusBar.js';
import { Messages } from './Messages.js';
import { Spinner } from './Spinner.js';
import { InputArea } from './input/InputArea.js';
import { PermissionDialog } from './modals/PermissionDialog.js';
import { SlashCommandOverlay } from './SlashCommandOverlay.js';
import type { UIMessage, ContentBlock, PermissionState } from '../context.js';
import type { ActoviqPermissionMode } from 'actoviq-agent-sdk';
import type { CompletionItem } from '../hooks/useAutocomplete.js';

interface MainLayoutProps {
  sessionName: string;
  model: string;
  permissionMode: ActoviqPermissionMode;
  streaming: boolean;
  messages: UIMessage[];
  streamingText: string;
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
}

export function MainLayout({
  sessionName, model, permissionMode, streaming,
  messages, streamingText, streamingBlocks, error,
  permissionDialog, overlay,
  inputHistory, inputValue,
  onSend, onInputChange, onTabComplete,
  suppressChar,
}: MainLayoutProps) {
  const scrollable = (
    <Box flexDirection="column" flexGrow={1}>
      <Messages
        messages={messages}
        streamingBlocks={streamingBlocks}
        error={error}
      />
      <Spinner visible={streaming && streamingBlocks.length === 0} />
    </Box>
  );

  const bottom = (
    <Box flexDirection="column">
      {overlay}
      {permissionDialog && <PermissionDialog state={permissionDialog} />}
        <InputArea
        onSubmit={onSend}
        onInputChange={onInputChange}
        onTabComplete={onTabComplete}
        streaming={streaming}
        initialValue={inputValue}
        suppressChar={suppressChar}
      />
      <StatusBar
        sessionName={sessionName}
        model={model}
        permissionMode={permissionMode}
        streaming={streaming}
        messageCount={messages.length}
      />
    </Box>
  );

  return (
    <FullscreenLayout
      scrollable={scrollable}
      bottom={bottom}
      overlay={null}
      modal={null}
    />
  );
}
