import { describe, expect, it } from 'vitest';
import { extractConversationBrief } from '../src/runtime/messageUtils.js';
import type { MessageParam } from '../src/provider/types.js';

describe('extractConversationBrief', () => {
  it('uses the first real user prompt', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: '<system-reminder>ignore</system-reminder>' },
      { role: 'user', content: 'Fix the sidebar session labels' },
      { role: 'assistant', content: 'Sure.' },
    ];
    expect(extractConversationBrief(messages)).toBe('Fix the sidebar session labels');
  });

  it('collapses whitespace in the brief', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Hello\n\n  world' },
    ];
    expect(extractConversationBrief(messages)).toBe('Hello world');
  });

  it('falls back when there is no user text', () => {
    const messages: MessageParam[] = [
      { role: 'assistant', content: 'Only assistant text' },
    ];
    expect(extractConversationBrief(messages)).toContain('Only assistant text');
  });
});
