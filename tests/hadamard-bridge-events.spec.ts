import { describe, expect, it } from 'vitest';

import {
  analyzeHadamardBridgeEvents,
  extractHadamardBridgeTaskInvocations,
  extractHadamardBridgeToolRequests,
  extractHadamardBridgeToolResults,
  getHadamardBridgeTextDelta,
  type HadamardBridgeJsonEvent,
} from '../src/index.js';

describe('Hadamard bridge event helpers', () => {
  it('extracts text deltas from bridge stream events', () => {
    const event: HadamardBridgeJsonEvent = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'hello',
        },
      },
    };

    expect(getHadamardBridgeTextDelta(event)).toBe('hello');
  });

  it('extracts tool requests, task invocations, and tool results', () => {
    const assistantEvent: HadamardBridgeJsonEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_task',
            name: 'Task',
            input: {
              description: 'Investigate test failures',
              prompt: 'Inspect the failing test suite and summarize the likely cause.',
              subagent_type: 'reviewer',
            },
          },
          {
            type: 'mcp_tool_use',
            id: 'toolu_read',
            name: 'read_file',
            input: {
              path: 'README.md',
            },
          },
        ],
      },
    };

    const userEvent: HadamardBridgeJsonEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_task',
            is_error: false,
            content: [{ type: 'text', text: 'done' }],
          },
        ],
      },
    };

    expect(extractHadamardBridgeToolRequests(assistantEvent)).toEqual([
      {
        id: 'toolu_task',
        name: 'Task',
        provider: 'runtime',
        blockType: 'tool_use',
        input: {
          description: 'Investigate test failures',
          prompt: 'Inspect the failing test suite and summarize the likely cause.',
          subagent_type: 'reviewer',
        },
      },
      {
        id: 'toolu_read',
        name: 'read_file',
        provider: 'mcp',
        blockType: 'mcp_tool_use',
        input: {
          path: 'README.md',
        },
      },
    ]);

    expect(extractHadamardBridgeTaskInvocations(assistantEvent)).toEqual([
      {
        id: 'toolu_task',
        name: 'Task',
        provider: 'runtime',
        description: 'Investigate test failures',
        prompt: 'Inspect the failing test suite and summarize the likely cause.',
        subagentType: 'reviewer',
        input: {
          description: 'Investigate test failures',
          prompt: 'Inspect the failing test suite and summarize the likely cause.',
          subagent_type: 'reviewer',
        },
      },
    ]);

    expect(extractHadamardBridgeToolResults(userEvent)).toEqual([
      {
        toolUseId: 'toolu_task',
        isError: false,
        blockType: 'tool_result',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);

    expect(analyzeHadamardBridgeEvents([assistantEvent, userEvent])).toMatchObject({
      toolRequests: expect.any(Array),
      taskInvocations: expect.any(Array),
      toolResults: expect.any(Array),
    });
  });
});
