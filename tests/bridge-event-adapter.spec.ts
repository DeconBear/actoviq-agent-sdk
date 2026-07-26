import { describe, expect, it } from 'vitest';

import {
  bridgeEventToAgentEvents,
  createBridgeEventAdapterState,
} from '../src/parity/bridgeEventAdapter.js';

describe('bridgeEventToAgentEvents', () => {
  it('emits stream deltas with the owning run metadata', () => {
    const [event] = bridgeEventToAgentEvents({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    }, 'native', 'run-1', 'claude');

    expect(event).toMatchObject({
      type: 'response.text.delta',
      runId: 'run-1',
      iteration: 0,
      delta: 'hello',
      snapshot: 'hello',
    });
  });

  it('accumulates the text snapshot within one adapted run', () => {
    const state = createBridgeEventAdapterState();
    const event = (text: string) => bridgeEventToAgentEvents({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    }, 'native', 'run-1', 'claude', state)[0];

    expect(event('hello')).toMatchObject({ delta: 'hello', snapshot: 'hello' });
    expect(event(' world')).toMatchObject({ delta: ' world', snapshot: 'hello world' });
  });

  it('emits complete AgentEvent tool call payloads', () => {
    const [event] = bridgeEventToAgentEvents({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file: 'x' } }],
      },
    }, 'native', 'run-1', 'claude');

    expect(event).toMatchObject({
      type: 'tool.call',
      call: {
        id: 'call-1',
        name: 'Read',
        publicName: 'Read',
        provider: 'local',
        input: { file: 'x' },
      },
    });
  });

  it('reads Claude tool results from message content', () => {
    const [event] = bridgeEventToAgentEvents({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [{ type: 'text', text: 'file contents' }],
        }],
      },
    }, 'native', 'run-1', 'claude');

    expect(event).toMatchObject({
      type: 'tool.result',
      result: {
        id: 'call-1',
        outputText: 'file contents',
        isError: false,
      },
    });
  });
});
