import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createAgentSdk,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageParam, MessageStreamEvent } from '../src/provider/types.js';
import {
  compactActoviqConversationIfNeeded,
  formatActoviqCompactSummary,
} from '../src/runtime/actoviqCompact.js';
import { createTodoWriteTool } from '../src/tools/todo/TodoWriteTool.js';
import type { ActoviqCompactConfig } from '../src/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-loop-compact-'));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(
  content: unknown[],
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
  inputTokens = 10,
): Message {
  messageCounter += 1;
  return {
    id: `msg_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: inputTokens,
      output_tokens: 5,
    },
  } as Message;
}

class MockStream implements ModelStreamHandle {
  constructor(
    private readonly events: MessageStreamEvent[],
    private readonly message: Message,
  ) {}

  async finalMessage(): Promise<Message> {
    return this.message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class MockModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  readonly streamCalls: ModelRequest[] = [];

  constructor(
    private readonly handlers: {
      create?: (request: ModelRequest, index: number) => Message;
      stream?: (request: ModelRequest, index: number) => {
        events: MessageStreamEvent[];
        message: Message;
      };
    },
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    if (!this.handlers.create) {
      throw new Error('Unexpected createMessage call.');
    }
    return this.handlers.create(request, this.createCalls.length - 1);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.streamCalls.push(structuredClone(request));
    if (!this.handlers.stream) {
      throw new Error('Unexpected streamMessage call.');
    }
    const response = this.handlers.stream(request, this.streamCalls.length - 1);
    return new MockStream(response.events, response.message);
  }
}

function baseCompactConfig(overrides: Partial<ActoviqCompactConfig> = {}): ActoviqCompactConfig {
  return {
    enabled: true,
    autoCompactThresholdTokens: 20_000,
    preserveRecentMessages: 2,
    maxSummaryTokens: 256,
    microcompactEnabled: false,
    microcompactKeepRecentToolResults: 3,
    microcompactMinContentChars: 1_000,
    ...overrides,
  };
}

function isLoopCompactRequest(request: ModelRequest): boolean {
  return (
    typeof request.metadata === 'object' &&
    request.metadata !== null &&
    (request.metadata as Record<string, unknown>).actoviq_internal_task === 'loop_compact'
  );
}

describe('compactActoviqConversationIfNeeded', () => {
  it('returns the conversation unchanged below the threshold', async () => {
    const modelApi = new MockModelApi({});
    const messages: MessageParam[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: [{ type: 'text', text: 'short answer' }] },
    ];

    const outcome = await compactActoviqConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({ loopAutoCompactThresholdTokens: 5_000 }),
      maxTokens: 1_000,
      runKey: 'run-below-threshold',
    });

    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(messages);
    expect(modelApi.createCalls).toHaveLength(0);
  });

  it('summarizes old turns and preserves the recent tail above the threshold', async () => {
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'LOOP_COMPACT_SUMMARY of older turns' }]),
    });
    const filler = 'data '.repeat(120);
    const messages: MessageParam[] = [
      { role: 'user', content: `first request ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `analysis one ${filler}` }] },
      { role: 'user', content: `follow-up ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `analysis two ${filler}` }] },
      { role: 'user', content: 'latest question' },
    ];

    const outcome = await compactActoviqConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({ loopAutoCompactThresholdTokens: 100 }),
      maxTokens: 1_000,
      runKey: 'run-compact-success',
    });

    expect(outcome.compacted).toBe(true);
    expect(outcome.messagesSummarized).toBe(3);
    expect(outcome.preservedMessages).toBe(2);
    expect(outcome.messages).toHaveLength(3);
    expect(outcome.messages[0]?.content).toContain('LOOP_COMPACT_SUMMARY');
    expect(outcome.messages[0]?.content).toContain('<system-reminder>');
    expect(outcome.messages.at(-1)).toEqual(messages.at(-1));
    expect(outcome.tokenEstimateAfter).toBeLessThan(outcome.tokenEstimateBefore);
    expect(modelApi.createCalls).toHaveLength(1);
    expect(isLoopCompactRequest(modelApi.createCalls[0]!)).toBe(true);
    // The summary request should include tool-free serialized older turns.
    expect(String(modelApi.createCalls[0]?.messages[0]?.content)).toContain('analysis one');
  });

  it('keeps tool_use/tool_result pairs together when extending the preserved tail', async () => {
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'pairing summary' }]),
    });
    const filler = 'block '.repeat(120);
    const messages: MessageParam[] = [
      { role: 'user', content: `kick off ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `progress ${filler}` }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running tool' },
          { type: 'tool_use', id: 'toolu_pair_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_pair_1', content: 'tool says hi' },
        ],
      },
      { role: 'user', content: 'continue please' },
    ];

    const outcome = await compactActoviqConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({
        loopAutoCompactThresholdTokens: 100,
        preserveRecentMessages: 2,
      }),
      maxTokens: 1_000,
      runKey: 'run-pairing',
    });

    expect(outcome.compacted).toBe(true);
    const toolUseIndex = outcome.messages.findIndex(
      message =>
        Array.isArray(message.content) &&
        message.content.some(
          block =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_use',
        ),
    );
    const toolResultIndex = outcome.messages.findIndex(
      message =>
        Array.isArray(message.content) &&
        message.content.some(
          block =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolUseIndex).toBeGreaterThan(0);
    expect(toolResultIndex).toBe(toolUseIndex + 1);
  });

  it('never throws when the summary request fails and trips a circuit breaker', async () => {
    let attempts = 0;
    const modelApi = new MockModelApi({
      create: () => {
        attempts += 1;
        throw new Error('provider exploded');
      },
    });
    const filler = 'noise '.repeat(200);
    const messages: MessageParam[] = [
      { role: 'user', content: `one ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `two ${filler}` }] },
      { role: 'user', content: `three ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `four ${filler}` }] },
      { role: 'user', content: 'tail' },
    ];
    const context = {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({ loopAutoCompactThresholdTokens: 50 }),
      maxTokens: 1_000,
      runKey: 'run-circuit-breaker',
    };

    for (let i = 0; i < 3; i += 1) {
      const outcome = await compactActoviqConversationIfNeeded(messages, context);
      expect(outcome.compacted).toBe(false);
      expect(outcome.messages).toEqual(messages);
    }
    expect(attempts).toBe(3);

    // Circuit breaker open: no further provider calls.
    const finalOutcome = await compactActoviqConversationIfNeeded(messages, context);
    expect(finalOutcome.compacted).toBe(false);
    expect(attempts).toBe(3);
  });
});

describe('conversation engine in-loop auto-compact', () => {
  it('compacts a growing run mid-loop and continues with the summary', async () => {
    const sessionDirectory = await createSessionDirectory();
    const bigChunk = 'X'.repeat(2_400);
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (isLoopCompactRequest(request)) {
          return makeMessage([{ type: 'text', text: 'LOOP_COMPACT_SUMMARY for the run' }]);
        }
        const regularIndex = index - (index > 0 ? 1 : 0);
        if (regularIndex === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Fetching data.' },
              { type: 'tool_use', id: 'toolu_big_1', name: 'big_lookup', input: {} },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'All done after compact.' }]);
      },
    });
    const bigLookup = tool(
      {
        name: 'big_lookup',
        description: 'Returns a large payload.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => bigChunk,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        loopAutoCompactThresholdTokens: 300,
        preserveRecentMessages: 2,
        microcompactEnabled: false,
      },
    });

    try {
      const result = await sdk.run('Start a long data crunch.', { tools: [bigLookup] });

      expect(result.text).toContain('All done after compact.');
      const compactCalls = modelApi.createCalls.filter(isLoopCompactRequest);
      expect(compactCalls).toHaveLength(1);

      const lastRegularCall = modelApi.createCalls.at(-1)!;
      expect(isLoopCompactRequest(lastRegularCall)).toBe(false);
      const firstMessageText = String(lastRegularCall.messages[0]?.content ?? '');
      expect(firstMessageText).toContain('LOOP_COMPACT_SUMMARY');
      expect(firstMessageText).toContain('<system-reminder>');

      // The final conversation also starts from the summary boundary.
      expect(String(result.messages[0]?.content ?? '')).toContain('LOOP_COMPACT_SUMMARY');
    } finally {
      await sdk.close();
    }
  });

  it('uses provider-reported input tokens to trigger in-loop compact', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (isLoopCompactRequest(request)) {
          return makeMessage([{ type: 'text', text: 'USAGE_TRIGGERED_SUMMARY' }]);
        }
        const regularIndex = index - (index > 0 ? 1 : 0);
        if (regularIndex === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_usage_1', name: 'small_lookup', input: {} },
            ],
            'tool_use',
            5_000,
          );
        }
        return makeMessage([{ type: 'text', text: 'Done after usage-triggered compact.' }]);
      },
    });
    const smallLookup = tool(
      {
        name: 'small_lookup',
        description: 'Returns a small payload.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => 'small',
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        loopAutoCompactThresholdTokens: 100,
        preserveRecentMessages: 1,
        microcompactEnabled: false,
      },
    });

    try {
      const result = await sdk.run('Trigger compact from real usage.', { tools: [smallLookup] });

      expect(result.text).toContain('Done after usage-triggered compact.');
      expect(modelApi.createCalls.filter(isLoopCompactRequest)).toHaveLength(1);
    } finally {
      await sdk.close();
    }
  });

  it('emits conversation.compacted in streamed runs', async () => {
    const sessionDirectory = await createSessionDirectory();
    const bigChunk = 'Y'.repeat(2_400);
    const modelApi = new MockModelApi({
      create: (request) => {
        if (isLoopCompactRequest(request)) {
          return makeMessage([{ type: 'text', text: 'STREAM_COMPACT_SUMMARY' }]);
        }
        throw new Error('Unexpected non-compact createMessage call in streamed run.');
      },
      stream: (_request, index) => {
        if (index < 2) {
          return {
            events: [],
            message: makeMessage(
              [
                { type: 'text', text: `Streaming tool call ${index + 1}.` },
                {
                  type: 'tool_use',
                  id: `toolu_stream_big_${index + 1}`,
                  name: 'big_lookup',
                  input: {},
                },
              ],
              'tool_use',
            ),
          };
        }
        return {
          events: [],
          message: makeMessage([{ type: 'text', text: 'Streamed completion.' }]),
        };
      },
    });
    const bigLookup = tool(
      {
        name: 'big_lookup',
        description: 'Returns a large payload.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => bigChunk,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        loopAutoCompactThresholdTokens: 300,
        preserveRecentMessages: 2,
        microcompactEnabled: false,
      },
    });

    try {
      const stream = sdk.stream('Long streamed crunch.', { tools: [bigLookup] });
      const compactedEvents: Array<Record<string, unknown>> = [];
      for await (const event of stream) {
        if (event.type === 'conversation.compacted') {
          compactedEvents.push(event as unknown as Record<string, unknown>);
        }
      }
      const result = await stream.result;

      expect(result.text).toContain('Streamed completion.');
      expect(compactedEvents.length).toBeGreaterThanOrEqual(1);
      for (const event of compactedEvents) {
        expect(event).toMatchObject({
          type: 'conversation.compacted',
          messagesSummarized: expect.any(Number),
          preservedMessages: expect.any(Number),
        });
      }
      // Once an older large tool result falls out of the preserved tail, the
      // compacted conversation must actually shrink.
      const lastEvent = compactedEvents.at(-1)!;
      expect(Number(lastEvent.tokenEstimateAfter)).toBeLessThan(
        Number(lastEvent.tokenEstimateBefore),
      );
    } finally {
      await sdk.close();
    }
  });
});

describe('consecutive tool failure handling', () => {
  it('marks the run incomplete and keeps tool_use/tool_result pairing intact', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) =>
        makeMessage(
          [
            { type: 'text', text: `Retrying broken tool, attempt ${index + 1}.` },
            {
              type: 'tool_use',
              id: `toolu_broken_${index + 1}`,
              name: 'always_fails',
              input: {},
            },
          ],
          'tool_use',
        ),
    });
    const alwaysFails = tool(
      {
        name: 'always_fails',
        description: 'A tool that always fails.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async (): Promise<string> => {
        throw new Error('boom');
      },
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Trigger repeated tool failures.', {
        tools: [alwaysFails],
      });

      expect(result.incompleteReason).toBe('consecutive_tool_failures:always_fails');
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls.every(call => call.isError)).toBe(true);

      // No dangling tool_use: every tool_use id has a matching tool_result.
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();
      for (const message of result.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (typeof block !== 'object' || block === null || !('type' in block)) continue;
          if (block.type === 'tool_use' && typeof (block as { id?: unknown }).id === 'string') {
            toolUseIds.add((block as { id: string }).id);
          }
          if (
            block.type === 'tool_result' &&
            typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
          ) {
            toolResultIds.add((block as { tool_use_id: string }).tool_use_id);
          }
        }
      }
      expect([...toolUseIds].filter(id => !toolResultIds.has(id))).toEqual([]);
      expect(result.messages.at(-1)?.role).toBe('user');
    } finally {
      await sdk.close();
    }
  });
});

describe('TodoWrite state tracking', () => {
  it('returns previous todos and embeds a current-state reminder in the result', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Planning the work.' },
              {
                type: 'tool_use',
                id: 'toolu_todo_1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'Implement feature', status: 'in_progress', activeForm: 'Implementing feature' },
                    { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
                  ],
                },
              },
            ],
            'tool_use',
          );
        }
        if (index === 1) {
          return makeMessage(
            [
              { type: 'text', text: 'Updating progress.' },
              {
                type: 'tool_use',
                id: 'toolu_todo_2',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'Implement feature', status: 'completed', activeForm: 'Implementing feature' },
                    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
                  ],
                },
              },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Todos tracked.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Track this work with todos.', {
        tools: [createTodoWriteTool()],
      });

      const firstOutput = result.toolCalls[0]?.outputText ?? '';
      expect(firstOutput).toContain('Todos have been modified successfully');
      expect(firstOutput).toContain('<system-reminder>');
      expect(firstOutput).toContain('[~] Implement feature (in progress: Implementing feature)');
      expect(firstOutput).toContain('[ ] Run tests');

      const secondOutput = result.toolCalls[1]?.outputText ?? '';
      expect(secondOutput).toContain('[x] Implement feature');
      expect(secondOutput).toContain('[~] Run tests (in progress: Running tests)');

      const secondRaw = result.toolCalls[1]?.output as {
        oldTodos: Array<{ content: string; status: string }>;
      };
      expect(secondRaw.oldTodos).toHaveLength(2);
      expect(secondRaw.oldTodos[0]).toMatchObject({
        content: 'Implement feature',
        status: 'in_progress',
      });
    } finally {
      await sdk.close();
    }
  });
});

describe('formatActoviqCompactSummary', () => {
  it('strips the analysis scratchpad and unwraps summary tags', () => {
    const raw = [
      '<analysis>',
      'Walking through the conversation chronologically...',
      '</analysis>',
      '<summary>',
      '1. Primary Request and Intent: fix the failing build.',
      '2. Key Technical Concepts: vitest, tsc.',
      '</summary>',
    ].join('\n');

    const formatted = formatActoviqCompactSummary(raw);
    expect(formatted).not.toContain('<analysis>');
    expect(formatted).not.toContain('chronologically');
    expect(formatted).not.toContain('<summary>');
    expect(formatted).toContain('Primary Request and Intent: fix the failing build.');
  });

  it('returns plain text untouched when no tags are present', () => {
    expect(formatActoviqCompactSummary('Just a plain summary.')).toBe('Just a plain summary.');
  });

  it('drops stray summary tags when the closing tag is missing', () => {
    const formatted = formatActoviqCompactSummary('<summary>Partial output without closing tag');
    expect(formatted).toBe('Partial output without closing tag');
  });
});
