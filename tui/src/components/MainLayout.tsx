import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
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
  contextPct?: number;
}

export function MainLayout({
  sessionName, model, permissionMode, streaming,
  messages, streamingBlocks, error,
  permissionDialog, overlay,
  inputHistory, inputValue,
  onSend, onInputChange, onTabComplete,
  suppressChar, startedAt, scrollOffset,
  phase, contextPct,
}: MainLayoutProps) {
  return (
    <Box flexDirection="column" width="100%">
      {/* Messages area — all messages visible, no scroll limit for now */}
      <Box flexDirection="column">
        <Messages
          messages={messages}
          streamingBlocks={streamingBlocks}
          error={error}
        />
        <Spinner visible={streaming && streamingBlocks.length === 0} phase={phase} />
      </Box>

      {/* Divider between messages and input */}
      <Box flexShrink={0}>
        <Text dim>──────────────────────────────────────────────</Text>
      </Box>

      {/* Permission / overlay */}
      {permissionDialog && (
        <Box flexShrink={0}>
          <PermissionDialog state={permissionDialog} />
        </Box>
      )}
      {overlay && (
        <Box flexShrink={0}>{overlay}</Box>
      )}

      {/* Bottom bar */}
      <Box flexDirection="column" flexShrink={0}>
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
          contextPct={contextPct}
        />
      </Box>
    </Box>
  );
}
