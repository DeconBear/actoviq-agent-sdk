import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { UIMessage, ContentBlock } from '../context.js';
import { ToolCallBlock } from './chat/ToolCallBlock.js';
import { renderMarkdown } from '../lib/markdown.js';

interface MessagesProps {
  messages: UIMessage[];
  streamingBlocks: ContentBlock[];
  error: string | null;
}

export const Messages = memo(function Messages({ messages, streamingBlocks, error }: MessagesProps) {
  return (
    <Box flexDirection="column">
      {messages.length === 0 && streamingBlocks.length === 0 && (
        <Box flexDirection="column" paddingY={1} paddingX={2}>
          <Text bold>Actoviq TUI Agent</Text>
          <Text dimColor>Type a message to start, or /help for commands.</Text>
          <Box marginTop={1}>
            <Text dimColor>Enter: send  |  Ctrl+C: abort  |  Ctrl+P: perm mode  |  Ctrl+L: clear</Text>
          </Box>
        </Box>
      )}

      {messages.map((msg) => (
        <MessageRow key={msg.id} message={msg} />
      ))}

      {streamingBlocks.length > 0 && (
        <StreamingRow blocks={streamingBlocks} />
      )}

      {error && (
        <Box paddingX={2} marginY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
});

// ── Message row ───────────────────────────────────────────────────

const MessageRow = memo(function MessageRow({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      {message.compactBoundary && (
        <Box paddingY={1}>
          <Text dimColor>── Compaction boundary ──</Text>
        </Box>
      )}
      {isUser ? (
        <Box flexDirection="row" gap={2}>
          <Box width={2} flexShrink={0}>
            <Text color="cyan" bold>{'>'}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text>{message.content[0]?.type === 'text' ? message.content[0].text : ''}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {message.content.map((block, i) => (
            <ContentBlockView key={i} block={block} />
          ))}
        </Box>
      )}
    </Box>
  );
});

// ── Streaming row ─────────────────────────────────────────────────

function StreamingRow({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      {blocks.map((block, i) => (
        <ContentBlockView key={i} block={block} live />
      ))}
    </Box>
  );
}

// ── Content block renderer ────────────────────────────────────────

function ContentBlockView({ block, live }: { block: ContentBlock; live?: boolean }) {
  switch (block.type) {
    case 'text':
      return <Text>{renderMarkdown(block.text)}</Text>;
    case 'thinking':
      return null; // Hidden by default
    case 'tool_use':
      return <ToolCallBlock toolUse={block} live={live} />;
    case 'tool_result':
      return (
        <Box marginLeft={2} marginY={1} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>└─</Text>
            <Text dimColor>{block.isError ? 'Error' : 'Result'}</Text>
            {block.durationMs != null && (
              <Text dimColor>({Math.round(block.durationMs / 1000)}s)</Text>
            )}
          </Box>
          <Box marginLeft={3} height={10} overflow="hidden">
            <Text dimColor>
              {block.content.length > 300 ? block.content.slice(0, 300) + '...' : block.content}
            </Text>
          </Box>
        </Box>
      );
  }
}
