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
} from '../src/index.js';
import { ActoviqProviderApiError } from '../src/errors.js';
import type { Message, MessageParam } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-loop-recovery-'));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): Message {
  messageCounter += 1;
  return {
    id: `msg_rec_${messageCounter}`,
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
      input_tokens: 10,
      output_tokens: 5,
    },
  } as Message;
}

function isLoopCompactRequest(request: ModelRequest): boolean {
  return (
    typeof request.metadata === 'object' &&
    request.metadata !== null &&
    (request.metadata as Record<string, unknown>).actoviq_internal_task === 'loop_compact'
  );
}

class RecoveryModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];

  constructor(
    private readonly create: (request: ModelRequest, index: number) => Message,
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return this.create(request, this.createCalls.length - 1);
  }

  // Streamed runs resolve through the same handler: an empty event stream
  // whose finalMessage (or synchronous throw) comes from `create`.
  streamMessage(request: ModelRequest) {
    this.createCalls.push(structuredClone(request));
    const message = this.create(request, this.createCalls.length - 1);
    return {
      async finalMessage(): Promise<Message> {
        return message;
      },
      async *[Symbol.asyncIterator]() {},
    };
  }
}

describe('reactive compact on prompt-too-long provider errors', () => {
  it('force-compacts the in-flight conversation and finishes the run', async () => {
    const sessionDirectory = await createSessionDirectory();
    const filler = 'data '.repeat(200);
    let regularCallIndex = -1;
    let promptTooLongThrown = false;
    const modelApi = new RecoveryModelApi((request) => {
      if (isLoopCompactRequest(request)) {
        return makeMessage([{ type: 'text', text: 'REACTIVE_SUMMARY of earlier work' }]);
      }
      regularCallIndex += 1;
      if (regularCallIndex === 0) {
        return makeMessage(
          [
            { type: 'text', text: `Working on it. ${filler}` },
            { type: 'tool_use', id: 'toolu_react_1', name: 'lookup', input: {} },
          ],
          'tool_use',
        );
      }
      if (regularCallIndex === 1) {
        promptTooLongThrown = true;
        throw new ActoviqProviderApiError('prompt is too long: 210000 tokens > 200000 maximum', {
          status: 400,
        });
      }
      return makeMessage([{ type: 'text', text: 'Recovered and finished.' }]);
    });
    const lookup = tool(
      {
        name: 'lookup',
        description: 'Returns data.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => `result ${filler}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        // High threshold: the proactive path must NOT fire; only the provider
        // rejection triggers the reactive compact.
        loopAutoCompactThresholdTokens: 1_000_000,
        autoCompactThresholdTokens: 1_000_000,
        preserveRecentMessages: 2,
        microcompactEnabled: false,
      },
    });

    try {
      const stream = sdk.stream('Run a long task.', { tools: [lookup] });
      const compactedEvents: Array<Record<string, unknown>> = [];
      for await (const event of stream) {
        if (event.type === 'conversation.compacted') {
          compactedEvents.push(event as unknown as Record<string, unknown>);
        }
      }
      const result = await stream.result;

      expect(promptTooLongThrown).toBe(true);
      expect(result.text).toContain('Recovered and finished.');
      expect(compactedEvents).toHaveLength(1);
      expect(compactedEvents[0]).toMatchObject({ trigger: 'reactive' });

      // Mid-run progress is preserved: the retried request starts from the
      // reactive summary boundary instead of restarting the whole run.
      const lastCall = modelApi.createCalls.at(-1)!;
      expect(isLoopCompactRequest(lastCall)).toBe(false);
      expect(JSON.stringify(lastCall.messages)).toContain('REACTIVE_SUMMARY');
      // The tool_use/tool_result pair survives in the final conversation.
      const serialized = JSON.stringify(result.messages);
      expect(serialized).toContain('toolu_react_1');
    } finally {
      await sdk.close();
    }
  });

  it('rethrows when the second attempt also fails (single-shot guard)', async () => {
    const sessionDirectory = await createSessionDirectory();
    const filler = 'mass '.repeat(200);
    let regularCallIndex = -1;
    const modelApi = new RecoveryModelApi((request) => {
      if (isLoopCompactRequest(request)) {
        return makeMessage([{ type: 'text', text: 'summary' }]);
      }
      regularCallIndex += 1;
      if (regularCallIndex === 0) {
        return makeMessage(
          [
            { type: 'text', text: `Step one. ${filler}` },
            { type: 'tool_use', id: 'toolu_guard_1', name: 'lookup', input: {} },
          ],
          'tool_use',
        );
      }
      throw new ActoviqProviderApiError('prompt is too long', { status: 400 });
    });
    const lookup = tool(
      {
        name: 'lookup',
        description: 'Returns data.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => `result ${filler}`,
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        loopAutoCompactThresholdTokens: 1_000_000,
        autoCompactThresholdTokens: 1_000_000,
        preserveRecentMessages: 2,
        microcompactEnabled: false,
      },
    });

    try {
      await expect(sdk.run('Run a long task.', { tools: [lookup] })).rejects.toThrow(
        /prompt is too long/,
      );
      // Exactly one reactive compact attempt, then the error surfaced.
      expect(modelApi.createCalls.filter(isLoopCompactRequest)).toHaveLength(1);
    } finally {
      await sdk.close();
    }
  });
});

describe('mid-run queued input steering', () => {
  it('injects drained user inputs alongside tool results for the next request', async () => {
    const sessionDirectory = await createSessionDirectory();
    let regularCallIndex = -1;
    const modelApi = new RecoveryModelApi((request) => {
      if (isLoopCompactRequest(request)) {
        throw new Error('No compaction expected in this test.');
      }
      regularCallIndex += 1;
      if (regularCallIndex === 0) {
        return makeMessage(
          [
            { type: 'text', text: 'Starting work.' },
            { type: 'tool_use', id: 'toolu_steer_1', name: 'lookup', input: {} },
          ],
          'tool_use',
        );
      }
      return makeMessage([{ type: 'text', text: 'Done with steering applied.' }]);
    });
    const lookup = tool(
      {
        name: 'lookup',
        description: 'Returns data.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => 'lookup result',
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    const queue = ['Please also update the changelog.'];
    try {
      const result = await sdk.run('Do the task.', {
        tools: [lookup],
        drainQueuedInputs: () => queue.splice(0),
      });

      expect(result.text).toContain('Done with steering applied.');
      expect(queue).toHaveLength(0);

      // The second request's last user message carries the tool_result AND
      // the queued steering text.
      const secondRequest = modelApi.createCalls.at(-1)!;
      const lastUser = secondRequest.messages.at(-1)! as MessageParam;
      expect(lastUser.role).toBe('user');
      const blocks = lastUser.content as Array<Record<string, unknown>>;
      expect(blocks.some((block) => block.type === 'tool_result')).toBe(true);
      const textBlock = blocks.find((block) => block.type === 'text');
      expect(String(textBlock?.text ?? '')).toContain('Please also update the changelog.');
      expect(String(textBlock?.text ?? '')).toContain('while you were working');

      // The steering text also persists in the final conversation history.
      expect(JSON.stringify(result.messages)).toContain('Please also update the changelog.');
    } finally {
      await sdk.close();
    }
  });
});
