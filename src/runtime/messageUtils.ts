import type { Message, MessageParam, ToolResultBlockParam } from '../provider/types.js';
import type { ActoviqSurfacedMemory } from '../types.js';

import { deepClone, isRecord } from './helpers.js';

export function normalizeUserContent(input: string | MessageParam['content']): MessageParam['content'] {
  if (typeof input === 'string') {
    return input;
  }
  return deepClone(input);
}

export function buildUserMessage(input: string | MessageParam['content']): MessageParam {
  return {
    role: 'user',
    content: normalizeUserContent(input),
  };
}

export function buildRelevantMemoryMessages(memories: readonly ActoviqSurfacedMemory[]): MessageParam[] {
  return memories.map(memory =>
    buildUserMessage(
      `<system-reminder>\n${memory.header}\n\n${memory.content}\n</system-reminder>`,
    ),
  );
}


export function assistantMessageToParam(message: Message): MessageParam {
  return {
    role: 'assistant',
    content: deepClone(message.content) as MessageParam['content'],
  };
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }
      switch (block.type) {
        case 'text':
          return typeof block.text === 'string' ? block.text : '';
        case 'thinking':
          return typeof block.thinking === 'string' ? block.thinking : '';
        case 'tool_result':
          return extractTextFromToolResultContent(block.content as ToolResultBlockParam['content']);
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function extractPreviewFromMessages(messages: MessageParam[]): string {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && extractTextFromContent(message.content));
  if (assistant) {
    return extractTextFromContent(assistant.content);
  }
  const user = messages.find((message) => message.role === 'user' && extractTextFromContent(message.content));
  return user ? extractTextFromContent(user.content) : '';
}

export function extractTextFromToolResultContent(content?: ToolResultBlockParam['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'document' && isRecord(block.source) && typeof block.source.data === 'string') {
        return block.source.data;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

