import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  compactHadamardConversationIfNeeded,
  compactHadamardSession,
  formatHadamardCompactSummary,
  resolveHadamardCompactBudget,
} from '../src/runtime/hadamardCompact.js';
import { createDefaultHadamardSessionMemoryRuntimeState } from '../src/memory/hadamardSessionMemoryState.js';
import { createTodoWriteTool } from '../src/tools/todo/TodoWriteTool.js';
import type { HadamardCompactConfig, StoredSession } from '../src/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-loop-compact-'));
  tempDirs.push(dir);
  return dir;
}

describe('model-driven compact budget', () => {
  it('derives 95% effective windows and a 90% automatic compact ceiling', () => {
    expect(resolveHadamardCompactBudget(baseCompactConfig({
      contextWindowTokens: 200_000,
      autoCompactThresholdTokens: undefined,
    }))).toMatchObject({
      rawContextWindowTokens: 200_000,
      effectiveContextWindowTokens: 190_000,
      autoCompactTokenLimit: 180_000,
    });
    expect(resolveHadamardCompactBudget(baseCompactConfig({
      contextWindowTokens: 1_000_000,
      autoCompactThresholdTokens: undefined,
    }))).toMatchObject({
      rawContextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 950_000,
      autoCompactTokenLimit: 900_000,
    });
  });

  it('clamps explicit limits and raw windows to model catalog maxima', () => {
    expect(resolveHadamardCompactBudget(baseCompactConfig({
      contextWindowTokens: 1_000_000,
      maxContextWindowTokens: 800_000,
      autoCompactTokenLimit: 950_000,
      autoCompactThresholdTokens: undefined,
    }))).toMatchObject({
      rawContextWindowTokens: 800_000,
      effectiveContextWindowTokens: 760_000,
      autoCompactTokenLimit: 720_000,
    });
  });
});

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

function baseCompactConfig(overrides: Partial<HadamardCompactConfig> = {}): HadamardCompactConfig {
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
    (request.metadata as Record<string, unknown>).hadamard_internal_task === 'loop_compact'
  );
}

describe('compactHadamardConversationIfNeeded', () => {
  it('returns the conversation unchanged below the threshold', async () => {
    const modelApi = new MockModelApi({});
    const messages: MessageParam[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: [{ type: 'text', text: 'short answer' }] },
    ];

    const outcome = await compactHadamardConversationIfNeeded(messages, {
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

    const outcome = await compactHadamardConversationIfNeeded(messages, {
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

  it('does not write microcompact-only tool_result clears back into the conversation', async () => {
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'SUMMARY after clearing verbose tool output' }]),
    });
    const longToolResult = 'tool-payload-'.repeat(400);
    const messages: MessageParam[] = [
      { role: 'user', content: 'inspect the large output' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_old', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: longToolResult }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_new', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'tiny' }],
      },
    ];

    const outcome = await compactHadamardConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({
        loopAutoCompactThresholdTokens: 50,
        microcompactEnabled: true,
        microcompactKeepRecentToolResults: 1,
        microcompactMinContentChars: 20,
        preserveRecentMessages: 2,
      }),
      maxTokens: 1_000,
      runKey: 'run-no-partial-microcompact',
    });

    // Must go through full summary compact rather than permanently clearing
    // historical tool_result content in place.
    expect(outcome.reason).toBe('compacted');
    expect(outcome.compacted).toBe(true);
    expect(outcome.messagesSummarized).toBeGreaterThan(0);
    expect(JSON.stringify(outcome.messages)).not.toContain(longToolResult.slice(0, 40));
    expect(modelApi.createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps preserved-tail tool results intact under preserveRecentUserTokens', async () => {
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'token-window summary' }]),
    });
    const oldPayload = `old-tool-${'x'.repeat(2_000)}`;
    const preservedPayload = `keep-tool-${'y'.repeat(400)}`;
    const messages: MessageParam[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_old', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: oldPayload }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'noted old' }] },
      { role: 'user', content: 'continue with a recent tool result that must stay intact' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_keep', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_keep', content: preservedPayload }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
    ];

    const outcome = await compactHadamardConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({
        loopAutoCompactThresholdTokens: 100,
        microcompactEnabled: true,
        // Clear every large tool_result in the summarize region — the bug was
        // clearing ones that still fall inside the preserve token window.
        microcompactKeepRecentToolResults: 0,
        microcompactMinContentChars: 50,
        preserveRecentUserTokens: 250,
      }),
      maxTokens: 1_000,
      runKey: 'run-preserve-token-tail',
    });

    expect(outcome.compacted).toBe(true);
    expect(JSON.stringify(outcome.messages)).toContain(preservedPayload.slice(0, 40));
    expect(JSON.stringify(outcome.messages)).not.toContain('[Old tool result content cleared]');
    expect(JSON.stringify(outcome.messages)).not.toContain(oldPayload.slice(0, 40));
  });

  it('leaves the conversation unchanged when summary compaction fails', async () => {
    const modelApi = new MockModelApi({
      create: () => {
        throw new Error('summary model unavailable');
      },
    });
    const longToolResult = 'fail-payload-'.repeat(300);
    const messages: MessageParam[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: longToolResult }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
    ];

    const outcome = await compactHadamardConversationIfNeeded(messages, {
      model: 'test-model',
      modelApi,
      compactConfig: baseCompactConfig({
        loopAutoCompactThresholdTokens: 50,
        microcompactEnabled: true,
        microcompactKeepRecentToolResults: 0,
        microcompactMinContentChars: 20,
        preserveRecentMessages: 2,
      }),
      maxTokens: 1_000,
      runKey: 'run-compact-fail-unchanged',
    });

    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe('failed');
    expect(outcome.messages).toEqual(messages);
    expect(JSON.stringify(outcome.messages)).toContain(longToolResult.slice(0, 40));
    expect(JSON.stringify(outcome.messages)).not.toContain('[Old tool result content cleared]');
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

    const outcome = await compactHadamardConversationIfNeeded(messages, {
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
      const outcome = await compactHadamardConversationIfNeeded(messages, context);
      expect(outcome.compacted).toBe(false);
      expect(outcome.messages).toEqual(messages);
    }
    expect(attempts).toBe(3);

    // Circuit breaker open: no further provider calls.
    const finalOutcome = await compactHadamardConversationIfNeeded(messages, context);
    expect(finalOutcome.compacted).toBe(false);
    expect(attempts).toBe(3);
  });
});

describe('conversation engine in-loop auto-compact', () => {
  it('keeps the raw JSONL transcript append-only when active context is compacted mid-turn', async () => {
    const root = await createSessionDirectory();
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    await Promise.all([mkdir(homeDir), mkdir(workDir)]);
    const bigPrompt = `RAW_ONLY_${'Z'.repeat(2_400)}`;
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (isLoopCompactRequest(request)) {
          return makeMessage([{ type: 'text', text: 'APPEND_ONLY_SUMMARY' }]);
        }
        const regularIndex = index - (index > 0 ? 1 : 0);
        return regularIndex === 0
          ? makeMessage([{ type: 'tool_use', id: 'toolu_raw', name: 'raw_lookup', input: {} }], 'tool_use', 5_000)
          : makeMessage([{ type: 'text', text: 'Finished.' }]);
      },
    });
    const rawLookup = tool({
      name: 'raw_lookup',
      description: 'Returns transcript-only content.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    }, async () => 'small result');
    const sdk = await createAgentSdk({
      homeDir,
      workDir,
      model: 'test-model',
      modelApi,
      compact: {
        loopAutoCompactThresholdTokens: 300,
        preserveRecentMessages: 2,
        microcompactEnabled: false,
      },
    });
    try {
      const session = await sdk.createSession();
      await session.send(bigPrompt, { tools: [rawLookup] });
      const paths = await sdk.memory.paths({ sessionId: session.id });
      const transcript = await readFile(path.join(paths.projectStateDir, `${session.id}.jsonl`), 'utf8');
      expect(transcript).toContain('RAW_ONLY_');
      expect(JSON.stringify(session.messages)).not.toContain('RAW_ONLY_');
      expect(JSON.stringify(session.messages)).toContain('APPEND_ONLY_SUMMARY');
    } finally {
      await sdk.close();
    }
  });

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
            5_000,
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
              5_000,
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

  it('stops after three consecutive permission denials even when tool names change', async () => {
    const sessionDirectory = await createSessionDirectory();
    const toolNames = ['denied_one', 'denied_two', 'denied_three'];
    const modelApi = new MockModelApi({
      create: (_request, index) => makeMessage(
        [{
          type: 'tool_use',
          id: `toolu_denied_${index + 1}`,
          name: toolNames[index] ?? toolNames.at(-1)!,
          input: {},
        }],
        'tool_use',
      ),
    });
    const tools = toolNames.map(name => tool(
      {
        name,
        description: `${name} must not execute.`,
        inputSchema: z.strictObject({}),
      },
      async () => 'unexpected execution',
    ));
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      permissionMode: 'bypassPermissions',
      permissions: toolNames.map(toolName => ({ toolName, behavior: 'deny' as const })),
    });

    try {
      const result = await sdk.run('Keep trying denied tools.', { tools });

      expect(result.incompleteReason).toBe('consecutive_permission_denials');
      expect(result.toolCalls).toHaveLength(3);
      expect(result.permissionDecisions?.map(item => item.behavior)).toEqual([
        'deny',
        'deny',
        'deny',
      ]);
      expect(modelApi.createCalls).toHaveLength(3);
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

describe('compactHadamardSession prefix stability', () => {
  function makeStoredSession(messages: MessageParam[]): StoredSession {
    return {
      version: 1,
      revision: 0,
      id: 'session-prefix-stable',
      title: 'prefix stable',
      titleSource: 'manual',
      model: 'test-model',
      tags: [],
      metadata: {},
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      status: 'idle',
      messages,
      runs: [],
    };
  }

  it('does not persist microcompact-only tool_result clears below the auto threshold', async () => {
    const modelApi = new MockModelApi({
      create: () => {
        throw new Error('summary should not run below threshold');
      },
    });
    const longToolResult = 'session-payload-'.repeat(400);
    const messages: MessageParam[] = [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_old', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: longToolResult }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_new', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'tiny' }],
      },
    ];
    const session = makeStoredSession(messages);

    const { session: next, result } = await compactHadamardSession(
      session,
      { trigger: 'auto' },
      {
        workDir: process.cwd(),
        model: 'test-model',
        modelApi,
        compactConfig: baseCompactConfig({
          // High enough that only microcompact would previously have fired.
          autoCompactThresholdTokens: 1_000_000,
          microcompactEnabled: true,
          microcompactKeepRecentToolResults: 1,
          microcompactMinContentChars: 20,
        }),
        runtimeState: createDefaultHadamardSessionMemoryRuntimeState(),
      },
    );

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('threshold_not_met');
    expect(next.messages).toEqual(messages);
    expect(JSON.stringify(next.messages)).toContain(longToolResult.slice(0, 40));
    expect(JSON.stringify(next.messages)).not.toContain('[Old tool result content cleared]');
    expect(modelApi.createCalls).toHaveLength(0);
  });

  it('summarizes when over threshold instead of leaving cleared tool results in place', async () => {
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'SESSION_SUMMARY of older turns' }]),
    });
    const longToolResult = 'overflow-payload-'.repeat(500);
    const messages: MessageParam[] = [
      { role: 'user', content: `big context ${longToolResult}` },
      { role: 'assistant', content: [{ type: 'text', text: `analysis ${longToolResult}` }] },
      { role: 'user', content: `follow ${longToolResult}` },
      { role: 'assistant', content: [{ type: 'text', text: 'tail answer' }] },
      { role: 'user', content: 'latest' },
    ];
    const session = makeStoredSession(messages);

    const { session: next, result } = await compactHadamardSession(
      session,
      { trigger: 'auto', preserveRecentMessages: 2 },
      {
        workDir: process.cwd(),
        model: 'test-model',
        modelApi,
        compactConfig: baseCompactConfig({
          autoCompactThresholdTokens: 50,
          microcompactEnabled: true,
          microcompactKeepRecentToolResults: 0,
          microcompactMinContentChars: 20,
          preserveRecentMessages: 2,
        }),
        runtimeState: createDefaultHadamardSessionMemoryRuntimeState(),
      },
    );

    expect(result.compacted).toBe(true);
    expect(result.reason).toBe('compacted');
    expect(JSON.stringify(next.messages[0])).toContain('SESSION_SUMMARY');
    expect(modelApi.createCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('formatHadamardCompactSummary', () => {
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

    const formatted = formatHadamardCompactSummary(raw);
    expect(formatted).not.toContain('<analysis>');
    expect(formatted).not.toContain('chronologically');
    expect(formatted).not.toContain('<summary>');
    expect(formatted).toContain('Primary Request and Intent: fix the failing build.');
  });

  it('returns plain text untouched when no tags are present', () => {
    expect(formatHadamardCompactSummary('Just a plain summary.')).toBe('Just a plain summary.');
  });

  it('drops stray summary tags when the closing tag is missing', () => {
    const formatted = formatHadamardCompactSummary('<summary>Partial output without closing tag');
    expect(formatted).toBe('Partial output without closing tag');
  });
});
