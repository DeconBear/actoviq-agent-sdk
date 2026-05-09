import React, { memo, useState } from 'react';
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
            <ContentBlockView key={blockKey(block, i)} block={block} />
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
        <ContentBlockView key={blockKey(block, i)} block={block} live />
      ))}
    </Box>
  );
}

// ── Content block renderer ────────────────────────────────────────

const ContentBlockView = memo(function ContentBlockView(
  { block, live }: { block: ContentBlock; live?: boolean },
) {
  switch (block.type) {
    case 'separator':
      return (
        <Box paddingY={1} paddingX={2}>
          <Text dimColor>
            ── Reasoning loop {block.iteration} ──
          </Text>
        </Box>
      );

    case 'text':
      return <Text>{renderMarkdown(block.text)}</Text>;

    case 'thinking':
      return <ThinkingBlock thinking={block} />;

    case 'tool_use':
      return <ToolCallBlock toolUse={block} live={live} />;

    case 'tool_result':
      return (
        <Box marginLeft={2} marginY={1} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>└─</Text>
            <Text dimColor color={block.isError ? 'red' : undefined}>
              {block.isError ? 'Error' : 'Result'}
            </Text>
            {block.durationMs != null && (
              <Text dimColor>({formatDuration(block.durationMs)})</Text>
            )}
            {block.iteration != null && block.iteration > 0 && (
              <Text dimColor>loop {block.iteration}</Text>
            )}
          </Box>
          <Box marginLeft={3} paddingRight={2}>
            <Text dimColor>
              {truncateOutput(block.content, block.isError)}
            </Text>
          </Box>
        </Box>
      );
  }
});

// ── Thinking block (collapsible) ──────────────────────────────────

const ThinkingBlock = memo(function ThinkingBlock(
  { thinking }: { thinking: Extract<ContentBlock, { type: 'thinking' }> },
) {
  const [expanded, setExpanded] = useState(!thinking.collapsed);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{expanded ? '▼' : '▶'}</Text>
        <Text dimColor>Thinking</Text>
        <Text dimColor>({estimateTokens(thinking.text)} tok)</Text>
      </Box>
      {expanded && (
        <Box marginLeft={3} marginTop={1}>
          <Text dimColor>
            {thinking.text.length > 500 ? thinking.text.slice(0, 500) + '...' : thinking.text}
          </Text>
        </Box>
      )}
    </Box>
  );
});

// ── Block key generator ──────────────────────────────────────────

function blockKey(block: ContentBlock, index: number): string {
  switch (block.type) {
    case 'tool_use': return `tu-${block.id}`;
    case 'tool_result': return `tr-${block.toolUseId}`;
    case 'separator': return `sep-${block.iteration}`;
    case 'thinking': return `th-${index}`;
    case 'text': return `tx-${index}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function truncateOutput(content: string, _isError: boolean): string {
  const lines = content.split('\n');
  if (lines.length > 20) {
    return lines.slice(0, 20).join('\n') + `\n... (${lines.length - 20} more lines)`;
  }
  if (content.length > 1000) {
    return content.slice(0, 1000) + '...';
  }
  return content;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
