import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActoviqProviderApiError,
  createAgentSdk,
  skill,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import { createTodoWriteTool } from '../src/tools/todo/TodoWriteTool.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-long-run-'));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(
  content: unknown[],
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn',
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

describe('concurrent read-only tool execution', () => {
  it('runs consecutive read-only tools in parallel and keeps result order', async () => {
    const sessionDirectory = await createSessionDirectory();
    let inFlight = 0;
    let maxInFlight = 0;
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Reading three sources.' },
              { type: 'tool_use', id: 'toolu_par_1', name: 'slow_read', input: { key: 'one' } },
              { type: 'tool_use', id: 'toolu_par_2', name: 'slow_read', input: { key: 'two' } },
              { type: 'tool_use', id: 'toolu_par_3', name: 'slow_read', input: { key: 'three' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'All reads done.' }]);
      },
    });
    const slowRead = tool(
      {
        name: 'slow_read',
        description: 'A slow read-only lookup.',
        inputSchema: z.strictObject({ key: z.string() }),
        isReadOnly: () => true,
      },
      async ({ key }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return `value:${key}`;
      },
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Read three things.', { tools: [slowRead] });

      expect(result.text).toContain('All reads done.');
      expect(maxInFlight).toBeGreaterThan(1);
      expect(result.toolCalls.map((call) => call.outputText)).toEqual([
        'value:one',
        'value:two',
        'value:three',
      ]);
      const toolResultsMessage = modelApi.createCalls[1]?.messages.at(-1);
      const blocks = Array.isArray(toolResultsMessage?.content) ? toolResultsMessage.content : [];
      expect(
        blocks
          .filter((block): block is { type: 'tool_result'; tool_use_id: string } =>
            typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result')
          .map((block) => block.tool_use_id),
      ).toEqual(['toolu_par_1', 'toolu_par_2', 'toolu_par_3']);
    } finally {
      await sdk.close();
    }
  });

  it('runs non-read-only tools serially', async () => {
    const sessionDirectory = await createSessionDirectory();
    let inFlight = 0;
    let maxInFlight = 0;
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_ser_1', name: 'slow_write', input: { key: 'a' } },
              { type: 'tool_use', id: 'toolu_ser_2', name: 'slow_write', input: { key: 'b' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Writes done.' }]);
      },
    });
    const slowWrite = tool(
      {
        name: 'slow_write',
        description: 'A slow mutating operation.',
        inputSchema: z.strictObject({ key: z.string() }),
        isReadOnly: () => false,
      },
      async ({ key }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return `wrote:${key}`;
      },
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      permissionMode: 'bypassPermissions',
    });

    try {
      const result = await sdk.run('Write two things.', { tools: [slowWrite] });
      expect(result.text).toContain('Writes done.');
      expect(maxInFlight).toBe(1);
    } finally {
      await sdk.close();
    }
  });
});

describe('tool interrupt behavior', () => {
  it('forwards caller cancellation only to cancel tools while every tool gets a deadline signal', async () => {
    const sessionDirectory = await createSessionDirectory();
    let blockSignal: AbortSignal | undefined;
    let cancelSignal: AbortSignal | undefined;
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_block', name: 'block_tool', input: {} },
              { type: 'tool_use', id: 'toolu_cancel', name: 'cancel_tool', input: {} },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'done' }]);
      },
    });
    const blockTool = tool(
      {
        name: 'block_tool',
        description: 'A blocking tool.',
        inputSchema: z.strictObject({}),
        interruptBehavior: 'block',
      },
      async (_input, context) => {
        blockSignal = context.signal;
        return 'blocked';
      },
    );
    const cancelTool = tool(
      {
        name: 'cancel_tool',
        description: 'A cancellable tool.',
        inputSchema: z.strictObject({}),
        interruptBehavior: 'cancel',
      },
      async (_input, context) => {
        cancelSignal = context.signal;
        return 'cancelled';
      },
    );
    const controller = new AbortController();
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: [blockTool, cancelTool],
    });

    try {
      await sdk.run('Run both tools.', { signal: controller.signal });

      expect(blockSignal).toBeDefined();
      expect(cancelSignal).toBeDefined();
      expect(blockSignal?.aborted).toBe(false);
      expect(cancelSignal?.aborted).toBe(false);

      controller.abort(new Error('caller stopped'));
      expect(cancelSignal?.aborted).toBe(true);
      expect(blockSignal?.aborted).toBe(false);
    } finally {
      await sdk.close();
    }
  });

  it('turns a hung local tool into a bounded tool error and continues the loop', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => index === 0
        ? makeMessage(
            [{ type: 'tool_use', id: 'toolu_hung', name: 'hung_tool', input: {} }],
            'tool_use',
          )
        : makeMessage([{ type: 'text', text: 'Recovered from the tool timeout.' }]),
    });
    const hungTool = tool(
      {
        name: 'hung_tool',
        description: 'Never completes.',
        inputSchema: z.strictObject({}),
      },
      async () => new Promise<string>(() => {}),
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: [hungTool],
      toolTimeoutMs: 20,
    });

    try {
      const result = await sdk.run('Call the hung tool.');
      expect(result.text).toContain('Recovered');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        isError: true,
        outputText: expect.stringContaining('20ms deadline'),
      });
    } finally {
      await sdk.close();
    }
  });
});

describe('run and hook deadlines', () => {
  it('bounds a model implementation that ignores AbortSignal', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi: ModelApi = {
      createMessage: async () => new Promise<Message>(() => {}),
      streamMessage: () => {
        throw new Error('Unexpected stream call.');
      },
    };
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      runTimeoutMs: 20,
    });

    try {
      await expect(sdk.run('Never completes.')).rejects.toMatchObject({
        code: 'DEADLINE_EXCEEDED',
        timeoutMs: 20,
      });
    } finally {
      await sdk.close();
    }
  });

  it('bounds a hook that ignores AbortSignal', async () => {
    const sessionDirectory = await createSessionDirectory();
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi: new MockModelApi({
        create: () => makeMessage([{ type: 'text', text: 'unreachable' }]),
      }),
      hookTimeoutMs: 20,
      hooks: {
        sessionStart: [async () => new Promise<never>(() => {})],
      },
    });

    try {
      await expect(sdk.run('Hook hangs.')).rejects.toMatchObject({
        code: 'DEADLINE_EXCEEDED',
        scope: 'sessionStart hook',
      });
    } finally {
      await sdk.close();
    }
  });
});

describe('session steering and follow-up queues', () => {
  it('injects steering queued during a tool before the next model request', async () => {
    const sessionDirectory = await createSessionDirectory();
    let sawSteering = false;
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (index === 0) {
          return makeMessage(
            [{ type: 'tool_use', id: 'toolu_steer', name: 'steer_tool', input: {} }],
            'tool_use',
          );
        }
        sawSteering = JSON.stringify(request.messages).includes('updated user guidance');
        return makeMessage([{ type: 'text', text: 'Steering applied.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });
    const session = await sdk.createSession({ title: 'steering' });
    const steerTool = tool(
      {
        name: 'steer_tool',
        description: 'Queues steering while a tool is active.',
        inputSchema: z.strictObject({}),
      },
      async () => {
        session.steer('updated user guidance');
        return 'tool complete';
      },
    );

    try {
      const result = await session.send('Run the steering tool.', { tools: [steerTool] });

      expect(result.text).toContain('Steering applied');
      expect(sawSteering).toBe(true);
      expect(session.pendingInputCount).toBe(0);
    } finally {
      await sdk.close();
    }
  });

  it('continues the same run with queued follow-up input after a natural stop', async () => {
    const sessionDirectory = await createSessionDirectory();
    let sawFollowUp = false;
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (index === 0) {
          return makeMessage([{ type: 'text', text: 'Initial answer.' }]);
        }
        sawFollowUp = JSON.stringify(request.messages).includes('verify the edge case');
        return makeMessage([{ type: 'text', text: 'Follow-up complete.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });
    const session = await sdk.createSession({ title: 'follow-up' });
    session.followUp('verify the edge case');

    try {
      const result = await session.send('Give the initial answer.');

      expect(result.text).toContain('Follow-up complete');
      expect(sawFollowUp).toBe(true);
      expect(session.pendingInputCount).toBe(0);
    } finally {
      await sdk.close();
    }
  });
});

describe('tool result size budgets', () => {
  it('artifacts results above the per-tool declared cap', async () => {
    const tempDir = await createSessionDirectory();
    const workDir = path.join(tempDir, 'workspace');
    const payload = 'P'.repeat(5_000);
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [{ type: 'tool_use', id: 'toolu_cap_1', name: 'capped_tool', input: {} }],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Capped tool done.' }]);
      },
    });
    const cappedTool = tool(
      {
        name: 'capped_tool',
        description: 'Tool with a small declared result cap.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
        maxResultSizeChars: 1_000,
      },
      async () => payload,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: tempDir,
      workDir,
      modelApi,
    });

    try {
      const result = await sdk.run('Run the capped tool.', { tools: [cappedTool] });
      const outputText = result.toolCalls[0]?.outputText ?? '';
      expect(outputText).toContain('Tool output was large');
      expect(outputText).not.toContain(payload);
    } finally {
      await sdk.close();
    }
  });

  it('enforces the aggregate per-message budget across parallel results', async () => {
    const tempDir = await createSessionDirectory();
    const workDir = path.join(tempDir, 'workspace');
    const chunk = 'Q'.repeat(4_000);
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_agg_1', name: 'bulk_read', input: { key: 'x' } },
              { type: 'tool_use', id: 'toolu_agg_2', name: 'bulk_read', input: { key: 'y' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Aggregate handled.' }]);
      },
    });
    const bulkRead = tool(
      {
        name: 'bulk_read',
        description: 'Returns a sizable payload.',
        inputSchema: z.strictObject({ key: z.string() }),
        isReadOnly: () => true,
        maxResultSizeChars: 100_000,
      },
      async () => chunk,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: tempDir,
      workDir,
      modelApi,
      compact: {
        toolResultsPerMessageMaxChars: 5_000,
      },
    });

    try {
      const result = await sdk.run('Read both sources.', { tools: [bulkRead] });
      expect(result.text).toContain('Aggregate handled.');

      const followUp = modelApi.createCalls[1]!;
      const lastMessage = followUp.messages.at(-1);
      const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
      const contents = blocks
        .filter((block) => (block as { type?: string }).type === 'tool_result')
        .map((block) => String((block as { content?: unknown }).content ?? ''));
      const artifacted = contents.filter((content) => content.includes('Tool output was large'));
      const intact = contents.filter((content) => content.includes(chunk));
      expect(artifacted.length).toBeGreaterThanOrEqual(1);
      expect(artifacted.length + intact.length).toBe(2);

      const artifactLine = artifacted[0]
        ?.split('\n')
        .find((line) => line.startsWith('Full output saved to: '));
      const artifactPath = artifactLine?.replace('Full output saved to: ', '');
      expect(artifactPath).toBeTruthy();
      expect(await readFile(artifactPath!, 'utf8')).toBe(chunk);
    } finally {
      await sdk.close();
    }
  });
});

describe('stream interruption recovery', () => {
  it('retries the iteration after a mid-stream transport failure', async () => {
    const sessionDirectory = await createSessionDirectory();
    let streamCallCount = 0;
    const failingStream: ModelStreamHandle = {
      async finalMessage(): Promise<Message> {
        throw new TypeError('terminated');
      },
      async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial before the socket dropped' },
        } as MessageStreamEvent;
        throw new TypeError('terminated', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        });
      },
    };
    const modelApi: ModelApi = {
      async createMessage(): Promise<Message> {
        throw new Error('Unexpected createMessage call.');
      },
      streamMessage(): ModelStreamHandle {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return failingStream;
        }
        return new MockStream([], makeMessage([{ type: 'text', text: 'Recovered cleanly.' }]));
      },
    };

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const stream = sdk.stream('Produce a long streamed answer.');
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result;

      expect(streamCallCount).toBe(2);
      expect(result.text).toBe('Recovered cleanly.');
      expect(eventTypes).toContain('request.interrupted');
    } finally {
      await sdk.close();
    }
  });

  it('resets stream interruption retry counts after a successful iteration', async () => {
    const sessionDirectory = await createSessionDirectory();
    let streamCallCount = 0;
    const makeFailingStream = (): ModelStreamHandle => ({
      async finalMessage(): Promise<Message> {
        throw new TypeError('terminated');
      },
      async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
        throw new TypeError('terminated', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        });
      },
    });
    const modelApi: ModelApi = {
      async createMessage(): Promise<Message> {
        throw new Error('Unexpected createMessage call.');
      },
      streamMessage(): ModelStreamHandle {
        streamCallCount += 1;
        if (streamCallCount === 1 || streamCallCount === 3) {
          return makeFailingStream();
        }
        if (streamCallCount === 2) {
          return new MockStream(
            [],
            makeMessage(
              [{ type: 'tool_use', id: 'toolu_step', name: 'step_tool', input: {} }],
              'tool_use',
            ),
          );
        }
        return new MockStream([], makeMessage([{ type: 'text', text: 'Recovered twice.' }]));
      },
    };
    const stepTool = tool(
      {
        name: 'step_tool',
        description: 'Advances the test run to a second model iteration.',
        inputSchema: z.strictObject({}),
      },
      async () => 'step complete',
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const stream = sdk.stream('Recover across two streamed iterations.', { tools: [stepTool] });
      const interruptions: Array<{ iteration: number; retry: number }> = [];
      for await (const event of stream) {
        if (event.type === 'request.interrupted') {
          interruptions.push({ iteration: event.iteration, retry: event.retry });
        }
      }
      const result = await stream.result;

      expect(streamCallCount).toBe(4);
      expect(result.text).toBe('Recovered twice.');
      expect(interruptions).toEqual([
        { iteration: 1, retry: 1 },
        { iteration: 2, retry: 1 },
      ]);
    } finally {
      await sdk.close();
    }
  });
});

describe('max_tokens truncation recovery', () => {
  it('nudges the model to resume after a truncated non-tool response', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage([{ type: 'text', text: 'Partial ans' }], 'max_tokens');
        }
        return makeMessage([{ type: 'text', text: 'Finished cleanly.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Produce a long answer.');

      expect(result.text).toContain('Finished cleanly.');
      expect(modelApi.createCalls).toHaveLength(2);
      const recoveryMessage = modelApi.createCalls[1]?.messages.at(-1);
      expect(recoveryMessage?.role).toBe('user');
      expect(JSON.stringify(recoveryMessage?.content)).toContain('Output token limit hit');
    } finally {
      await sdk.close();
    }
  });

  it('stops nudging after the recovery limit', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'still truncated' }], 'max_tokens'),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Trigger endless truncation.');
      // 1 initial + 3 recovery attempts
      expect(modelApi.createCalls).toHaveLength(4);
      expect(result.stopReason).toBe('max_tokens');
    } finally {
      await sdk.close();
    }
  });

  it('returns failed tool results instead of executing truncated tool calls', async () => {
    const sessionDirectory = await createSessionDirectory();
    let executed = false;
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if (index === 0) {
          return makeMessage(
            [{ type: 'tool_use', id: 'toolu_truncated', name: 'echo_tool', input: { raw: '{"value":' } }],
            'max_tokens',
          );
        }
        const lastMessage = request.messages.at(-1);
        expect(JSON.stringify(lastMessage)).toContain('JSON arguments were incomplete');
        return makeMessage([{ type: 'text', text: 'Retried without executing bad input.' }]);
      },
    });
    const echoTool = tool(
      {
        name: 'echo_tool',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
      },
      async () => {
        executed = true;
        return 'should-not-run';
      },
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: [echoTool],
    });

    try {
      const result = await sdk.run('Use a truncated tool call.');

      expect(result.text).toContain('Retried');
      expect(executed).toBe(false);
      expect(modelApi.createCalls).toHaveLength(2);
    } finally {
      await sdk.close();
    }
  });
});

describe('streamed content deltas', () => {
  it('emits thinking and tool-input deltas during streamed runs', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      stream: (_request, index) => {
        if (index > 0) {
          return {
            events: [
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'stream done' },
              } as MessageStreamEvent,
            ],
            message: makeMessage([{ type: 'text', text: 'stream done' }]),
          };
        }
        return {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            } as MessageStreamEvent,
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'considering' },
            } as MessageStreamEvent,
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_stream', name: 'echo_tool', input: {} },
            } as MessageStreamEvent,
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"value"' },
            } as MessageStreamEvent,
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: ':"hi"}' },
            } as MessageStreamEvent,
          ],
          message: makeMessage(
            [
              { type: 'thinking', thinking: 'considering' },
              { type: 'tool_use', id: 'toolu_stream', name: 'echo_tool', input: { value: 'hi' } },
            ],
            'tool_use',
          ),
        };
      },
    });
    const echoTool = tool(
      {
        name: 'echo_tool',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
      },
      async ({ value }) => `echo:${value}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: [echoTool],
    });

    try {
      const stream = sdk.stream('Stream tool construction.');
      const thinking: string[] = [];
      const toolInputSnapshots: string[] = [];

      for await (const event of stream) {
        if (event.type === 'response.thinking.delta') {
          thinking.push(event.delta);
        }
        if (event.type === 'response.tool_input.delta') {
          toolInputSnapshots.push(event.snapshot);
          expect(event.toolUseId).toBe('toolu_stream');
          expect(event.toolName).toBe('echo_tool');
        }
      }

      await stream.result;
      expect(thinking.join('')).toBe('considering');
      expect(toolInputSnapshots.at(-1)).toBe('{"value":"hi"}');
    } finally {
      await sdk.close();
    }
  });
});

describe('fallback model switching', () => {
  it('switches to the fallback model after retry-exhausted provider failures', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request) => {
        if (request.model === 'primary-model') {
          throw new ActoviqProviderApiError('Overloaded', { status: 529 });
        }
        return makeMessage([{ type: 'text', text: 'Fallback model answered.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'primary-model',
      fallbackModel: 'backup-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Answer despite overload.');

      expect(result.text).toContain('Fallback model answered.');
      expect(result.model).toBe('backup-model');
      expect(modelApi.createCalls.map((call) => call.model)).toEqual([
        'primary-model',
        'backup-model',
      ]);
    } finally {
      await sdk.close();
    }
  });

  it('rethrows when no fallback model is configured', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: () => {
        throw new ActoviqProviderApiError('Overloaded', { status: 529 });
      },
    });
    const sdk = await createAgentSdk({
      model: 'primary-model',
      sessionDirectory,
      modelApi,
    });

    try {
      await expect(sdk.run('No fallback available.')).rejects.toThrow('Overloaded');
    } finally {
      await sdk.close();
    }
  });
});

describe('todo continuity reminder', () => {
  it('re-injects todo guidance after ten iterations without TodoWrite', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index < 10) {
          return makeMessage(
            [
              { type: 'tool_use', id: `toolu_echo_${index}`, name: 'echo_tool', input: { value: `${index}` } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Long run finished.' }]);
      },
    });
    const echoTool = tool(
      {
        name: 'echo_tool',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async ({ value }) => `echo:${value}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const result = await sdk.run('Loop for a while.', {
        tools: [echoTool, createTodoWriteTool()],
      });
      expect(result.text).toContain('Long run finished.');

      const reminderRequests = modelApi.createCalls.filter((call) =>
        JSON.stringify(call.messages).includes('TodoWrite tool has not been used recently'),
      );
      expect(reminderRequests.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sdk.close();
    }
  });
});

describe('skill registry tool', () => {
  it('loads registered skill content through the Skill tool', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: { skill: 'release-check' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Followed the skill.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      skills: [
        skill({
          name: 'release-check',
          description: 'Release readiness checklist',
          prompt: 'Step A: run tests. Step B: update changelog.',
        }),
      ],
    });

    try {
      const result = await sdk.run('Prepare the release.');

      expect(modelApi.createCalls[0]?.system).toContain('Available skills');
      expect(modelApi.createCalls[0]?.system).toContain('release-check');
      const skillOutput = result.toolCalls.find((call) => call.publicName === 'Skill')?.outputText ?? '';
      expect(skillOutput).toContain('Loaded skill "release-check"');
      expect(skillOutput).toContain('Step A: run tests. Step B: update changelog.');
      expect(result.text).toContain('Followed the skill.');
    } finally {
      await sdk.close();
    }
  });

  it('lists available skills when an unknown skill is requested', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'tool_use', id: 'toolu_skill_x', name: 'Skill', input: { skill: 'nope' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Recovered from bad skill name.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      skills: [
        skill({
          name: 'release-check',
          description: 'Release readiness checklist',
          prompt: 'Checklist content.',
        }),
      ],
    });

    try {
      const result = await sdk.run('Use a wrong skill name.');
      const skillCall = result.toolCalls.find((call) => call.publicName === 'Skill');
      expect(skillCall?.isError).toBe(true);
      expect(skillCall?.outputText).toContain('release-check');
    } finally {
      await sdk.close();
    }
  });
});

describe('prompt cache breakpoints', () => {
  it('adds cache_control to tools and the last message on Anthropic hosts', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [{ type: 'tool_use', id: 'toolu_cache_1', name: 'echo_tool', input: { value: 'hi' } }],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Cached.' }]);
      },
    });
    const echoTool = tool(
      {
        name: 'echo_tool',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async ({ value }) => `echo:${value}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      await sdk.run('Echo once.', { tools: [echoTool] });

      const secondRequest = modelApi.createCalls[1]!;
      const lastTool = secondRequest.tools?.at(-1) as Record<string, unknown> | undefined;
      expect(lastTool?.cache_control).toEqual({ type: 'ephemeral' });
      const lastMessage = secondRequest.messages.at(-1);
      const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
      const lastBlock = blocks.at(-1) as Record<string, unknown> | undefined;
      expect(lastBlock?.cache_control).toEqual({ type: 'ephemeral' });
    } finally {
      await sdk.close();
    }
  });

  it('skips cache_control when prompt caching is disabled', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [{ type: 'tool_use', id: 'toolu_nocache_1', name: 'echo_tool', input: { value: 'hi' } }],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Uncached.' }]);
      },
    });
    const echoTool = tool(
      {
        name: 'echo_tool',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async ({ value }) => `echo:${value}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      promptCachingEnabled: false,
    });

    try {
      await sdk.run('Echo once.', { tools: [echoTool] });
      const secondRequest = modelApi.createCalls[1]!;
      expect(JSON.stringify(secondRequest)).not.toContain('cache_control');
    } finally {
      await sdk.close();
    }
  });
});
