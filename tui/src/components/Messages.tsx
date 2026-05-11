import React, { memo } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import type { UIMessage, ContentBlock } from '../context.js';
import { ToolCallBlock } from './chat/ToolCallBlock.js';
import { renderMarkdown } from '../lib/markdown.js';

interface MessagesProps {
  messages: UIMessage[];
  streamingBlocks: ContentBlock[];
  error: string | null;
}

export const Messages = memo(function Messages({ messages, streamingBlocks, error }: MessagesProps) {
  const totalMsgs = messages.length;

  return (
    <Box flexDirection="column">
      {totalMsgs === 0 && streamingBlocks.length === 0 && (
        <WelcomeScreen />
      )}

      {messages.map((msg) => (
        <MessageRow key={msg.id} message={msg} />
      ))}

      {streamingBlocks.length > 0 && (
        <StreamingRow blocks={streamingBlocks} />
      )}

      {error && (
        <Box paddingX={2} marginY={1}>
          <Text color="ansi:red">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
});

// ── Welcome screen ────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Box marginBottom={1}>
        <Text bold color="ansi:cyan">Actoviq</Text>
        <Text dim> — Terminal AI Agent</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dim>Type a message to start, or /help for commands.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dim>Enter  send    Ctrl+C  abort    Ctrl+P  perm mode    Ctrl+L  clear</Text>
        <Text dim>PgUp/Ctrl+B  scroll up    PgDn/Ctrl+F  scroll down    Tab  complete    ↑↓  history</Text>
      </Box>
    </Box>
  );
}

// ── Message row ───────────────────────────────────────────────────

const MessageRow = memo(function MessageRow({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      {message.compactBoundary && (
        <Box paddingY={1}>
          <Text dim>── Compaction boundary ──</Text>
        </Box>
      )}
      {isUser ? (
        <Box flexDirection="row" gap={1}>
          <Box width={2} flexShrink={0}>
            <Text color="ansi:cyan" bold>{'>'}</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {message.content.map((block, i) => (
              <ContentBlockView key={blockKey(block, i)} block={block} />
            ))}
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
          <Text dim>── Reasoning loop {block.iteration} ──</Text>
        </Box>
      );

    case 'text': {
      const lines = block.text.split('\n');
      if (lines.length <= 1) {
        return <Text>{renderMarkdown(block.text)}</Text>;
      }
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={`${i}`}>{renderMarkdown(line)}</Text>
          ))}
        </Box>
      );
    }

    case 'thinking':
      return <ThinkingBlock thinking={block} />;

    case 'tool_use':
      return <ToolCallBlock toolUse={block} live={live} />;

    case 'tool_result':
      return (
        <Box marginLeft={2} marginY={1} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dim>└─</Text>
            <Text color={block.isError ? 'ansi:red' : 'ansi:green'}>
              {block.isError ? '✗ Error' : '✓ Result'}
            </Text>
            {block.durationMs != null && (
              <Text dim>({formatDuration(block.durationMs)})</Text>
            )}
          </Box>
          <Box marginLeft={3} paddingRight={2}>
            <Text dim>{truncateOutput(block.content)}</Text>
          </Box>
        </Box>
      );
  }
});

// ── Thinking block ────────────────────────────────────────────────

const ThinkingBlock = memo(function ThinkingBlock(
  { thinking }: { thinking: Extract<ContentBlock, { type: 'thinking' }> },
) {
  const collapsed = thinking.collapsed !== false;
  const preview = thinking.text.length > 200
    ? thinking.text.slice(0, 200) + '...'
    : thinking.text;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" gap={1}>
        <Text dim>💭 Thinking</Text>
        <Text dim>({estimateTokens(thinking.text)} tok)</Text>
      </Box>
      {!collapsed && (
        <Box marginLeft={3} marginTop={1}>
          <Text dim>{preview}</Text>
        </Box>
      )}
    </Box>
  );
});

// ── Helpers ───────────────────────────────────────────────────────

function blockKey(block: ContentBlock, index: number): string {
  switch (block.type) {
    case 'tool_use': return `tu-${block.id}`;
    case 'tool_result': return `tr-${block.toolUseId}`;
    case 'separator': return `sep-${block.iteration}`;
    case 'thinking': return `th-${index}`;
    case 'text': return `tx-${index}`;
  }
}

function truncateOutput(content: string): string {
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
