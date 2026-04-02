import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-sdk-client-'));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): Message {
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
      input_tokens: 10,
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

describe('ActoviqAgentClient', () => {
  it('executes a local tool loop and returns the final response', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'I will use a tool.' },
              { type: 'tool_use', id: 'toolu_1', name: 'add_numbers', input: { a: 2, b: 3 } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'The answer is 5.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    const addNumbers = tool(
      {
        name: 'add_numbers',
        description: 'Add two numbers together.',
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
        }),
      },
      async ({ a, b }) => ({ sum: a + b }),
    );

    try {
      const result = await sdk.run('What is 2 + 3?', { tools: [addNumbers] });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.outputText).toContain('5');
      expect(result.text).toContain('5');
      expect(modelApi.createCalls).toHaveLength(2);
      expect(modelApi.createCalls[1]?.messages.at(-1)).toMatchObject({ role: 'user' });
    } finally {
      await sdk.close();
    }
  });

  it('persists session history and can resume a session', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (_request, index) => {
        if (index === 0) {
          return makeMessage([{ type: 'text', text: 'Okay, I will remember that.' }]);
        }
        return makeMessage([{ type: 'text', text: 'Your codename is Sparrow.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Remember that my codename is Sparrow.');
      const reply = await session.send('What is my codename?');
      const summaries = await sdk.sessions.list();
      const resumed = await sdk.resumeSession(session.id);

      expect(reply.text).toContain('Sparrow');
      expect(summaries[0]?.runCount).toBe(2);
      expect(resumed.messages.length).toBeGreaterThan(0);
      expect(session.title.length).toBeGreaterThan(0);
    } finally {
      await sdk.close();
    }
  });

  it('streams text deltas and resolves the final result', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      stream: () => ({
        events: [
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
          } as MessageStreamEvent,
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' world' },
          } as MessageStreamEvent,
        ],
        message: makeMessage([{ type: 'text', text: 'Hello world' }]),
      }),
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const stream = sdk.stream('Say hello.');
      const deltas: string[] = [];

      for await (const event of stream) {
        if (event.type === 'response.text.delta') {
          deltas.push(event.delta);
        }
      }

      const result = await stream.result;

      expect(deltas.join('')).toBe('Hello world');
      expect(result.text).toBe('Hello world');
    } finally {
      await sdk.close();
    }
  });

  it('auto-injects relevant memories and de-duplicates them across session turns', async () => {
    const tempDir = await createSessionDirectory();
    const homeDir = path.join(tempDir, 'home');
    const workDir = path.join(tempDir, 'workspace');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'Memory-aware response.' }]),
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: path.join(tempDir, 'sessions'),
      homeDir,
      workDir,
      modelApi,
    });

    try {
      await mkdir(workDir, { recursive: true });
      const paths = await sdk.memory.paths();
      await mkdir(paths.autoMemoryDir, { recursive: true });
      await writeFile(
        paths.autoMemoryEntrypoint,
        '- [Release Flow](release-flow.md) - Bump package version before tagging releases.\n',
        'utf8',
      );
      await writeFile(
        path.join(paths.autoMemoryDir, 'release-flow.md'),
        [
          '---',
          'type: project',
          'description: Release checklist for versions and tags',
          '---',
          '',
          'Always bump package.json before creating a release tag.',
        ].join('\n'),
        'utf8',
      );

      const session = await sdk.createSession();
      await session.send('How should I prepare a release tag?');
      await session.send('Remind me again how I should prepare a release tag?');

      const countRelevantMemoryMessages = (messages: ModelRequest['messages']) =>
        messages.filter(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('<system-reminder>') &&
            message.content.includes('release-flow.md'),
        ).length;

      const firstMessages = modelApi.createCalls[0]?.messages ?? [];
      const secondMessages = modelApi.createCalls[1]?.messages ?? [];

      expect(countRelevantMemoryMessages(firstMessages)).toBe(1);
      expect(countRelevantMemoryMessages(secondMessages)).toBe(1);
      expect(
        firstMessages.some(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('Always bump package.json before creating a release tag.'),
        ),
      ).toBe(true);
    } finally {
      await sdk.close();
    }
  });
});

