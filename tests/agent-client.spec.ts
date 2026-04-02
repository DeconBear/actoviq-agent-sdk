import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActoviqProviderApiError,
  createAgentSdk,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import { extractTextFromContent } from '../src/runtime/messageUtils.js';

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

  it('automatically extracts session memory after a large session turn', async () => {
    const tempDir = await createSessionDirectory();
    const homeDir = path.join(tempDir, 'home');
    const workDir = path.join(tempDir, 'workspace');
    const longPrompt = 'release-checklist '.repeat(4000);
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'session_memory') {
          return makeMessage([
            {
              type: 'text',
              text: [
                '# Session Title',
                '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
                '',
                'Release memory snapshot',
                '',
                '# Current State',
                '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
                '',
                'Preparing the next public release and checking version/tag order.',
              ].join('\n'),
            },
          ]);
        }

        return makeMessage([{ type: 'text', text: 'Working through the release checklist.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: path.join(tempDir, 'sessions'),
      homeDir,
      workDir,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send(longPrompt);

      const memoryState = await sdk.memory.readSessionMemory({
        projectPath: workDir,
        sessionId: session.id,
      });
      const compactState = await session.compactState({
        includeSessionMemory: true,
      });

      expect(modelApi.createCalls).toHaveLength(2);
      expect(
        (modelApi.createCalls[1]?.metadata as Record<string, unknown> | undefined)
          ?.actoviq_internal_task,
      ).toBe('session_memory');
      expect(memoryState.exists).toBe(true);
      expect(memoryState.content).toContain('Release memory snapshot');
      expect(compactState.runtimeState).toMatchObject({
        initialized: true,
        extractionCount: 1,
      });
      expect(compactState.canUseSessionMemoryCompaction).toBe(true);
    } finally {
      await sdk.close();
    }
  });

  it('can manually extract session memory on demand', async () => {
    const tempDir = await createSessionDirectory();
    const homeDir = path.join(tempDir, 'home');
    const workDir = path.join(tempDir, 'workspace');
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'session_memory') {
          return makeMessage([
            {
              type: 'text',
              text: [
                '# Session Title',
                '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
                '',
                'Manual summary',
                '',
                '# Current State',
                '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
                '',
                'Manual extraction captured the latest task details.',
              ].join('\n'),
            },
          ]);
        }

        return makeMessage([{ type: 'text', text: 'Small response.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: path.join(tempDir, 'sessions'),
      homeDir,
      workDir,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Keep this short.');
      const extraction = await session.extractMemory();
      const memoryState = await sdk.memory.readSessionMemory({
        projectPath: workDir,
        sessionId: session.id,
      });

      expect(extraction.success).toBe(true);
      expect(extraction.trigger).toBe('manual');
      expect(extraction.memoryPath).toBeTruthy();
      expect(memoryState.content).toContain('Manual summary');
      expect(modelApi.createCalls).toHaveLength(2);
    } finally {
      await sdk.close();
    }
  });

  it('can manually compact a session and persist compact state', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'compact') {
          return makeMessage([
            {
              type: 'text',
              text: 'Compact summary: keep the release ordering constraints and preserve the latest response.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: 'Detailed release checklist response with enough context to compact later.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Walk through the release checklist in detail.');
      const compacted = await session.compact({
        preserveRecentMessages: 1,
      });
      const compactState = await session.compactState({
        includeSessionMemory: true,
      });

      expect(compacted.compacted).toBe(true);
      expect(compacted.trigger).toBe('manual');
      expect(compacted.summaryMessage).toContain('Compact summary');
      expect(modelApi.createCalls).toHaveLength(2);
      expect(
        (modelApi.createCalls[1]?.metadata as Record<string, unknown> | undefined)
          ?.actoviq_internal_task,
      ).toBe('compact');
      expect(session.messages[0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('Compact summary'),
      });
      expect(compactState.compactCount).toBe(1);
      expect(compactState.hasCompacted).toBe(true);
      expect(compactState.summaryMessage).toContain('Compact summary');
      expect(compactState.pendingPostCompaction).toBe(true);
      expect(compactState.boundaries).toHaveLength(1);
      expect(compactState.latestBoundary?.kind).toBe('compact');
      expect(compactState.latestBoundarySummary).toContain('trigger=manual');
    } finally {
      await sdk.close();
    }
  });

  it('automatically compacts sessions when the compact threshold is exceeded', async () => {
    const sessionDirectory = await createSessionDirectory();
    const longPrompt = 'release-checklist '.repeat(40);
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'compact') {
          return makeMessage([
            {
              type: 'text',
              text: 'Auto compact summary: the earlier release planning details were condensed.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: 'Working through the long release checklist response.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        autoCompactThresholdTokens: 10,
        preserveRecentMessages: 1,
      },
    });

    try {
      const session = await sdk.createSession();
      await session.send(longPrompt);
      const compactState = await session.compactState({
        includeSessionMemory: true,
      });

      expect(modelApi.createCalls).toHaveLength(2);
      expect(
        (modelApi.createCalls[1]?.metadata as Record<string, unknown> | undefined)
          ?.actoviq_internal_task,
      ).toBe('compact');
      expect(compactState.compactCount).toBe(1);
      expect(compactState.summaryMessage).toContain('Auto compact summary');
      expect(compactState.pendingPostCompaction).toBe(true);
      expect(compactState.latestBoundary?.kind).toBe('compact');
      expect(compactState.latestBoundarySummary).toContain('trigger=auto');
      expect(session.messages[0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('Auto compact summary'),
      });
    } finally {
      await sdk.close();
    }
  });

  it('retries compaction when the compaction prompt itself is too long', async () => {
    const sessionDirectory = await createSessionDirectory();
    const longPrompt = 'release-checklist '.repeat(120);
    let compactAttempts = 0;
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'compact') {
          compactAttempts += 1;
          if (compactAttempts === 1) {
            throw new ActoviqProviderApiError('Provider request failed with HTTP 413: Prompt is too long', {
              status: 413,
            });
          }
          return makeMessage([
            {
              type: 'text',
              text: 'Retry compact summary: the earlier release planning was trimmed before summarization.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: 'Working through a very long release checklist response.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send(longPrompt);
      await session.send('Follow up on the same release plan with extra detail.');
      await session.compact({
        preserveRecentMessages: 1,
      });
      const compactState = await session.compactState({
        includeSessionMemory: true,
      });

      expect(compactAttempts).toBe(2);
      expect(compactState.compactCount).toBe(1);
      expect(compactState.latestBoundarySummary).toContain('retryCount=1');
      expect(compactState.latestBoundarySummary).toContain('droppedMessages=');
      expect(compactState.latestBoundarySummary).toContain('preservedMessages=1');
      expect(session.messages[0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('Retry compact summary'),
      });
    } finally {
      await sdk.close();
    }
  });

  it('reactively compacts and retries when the provider rejects an oversized prompt', async () => {
    const sessionDirectory = await createSessionDirectory();
    let nonCompactCalls = 0;
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'compact') {
          return makeMessage([
            {
              type: 'text',
              text: 'Reactive compact summary: prior release planning was condensed.',
            },
          ]);
        }

        nonCompactCalls += 1;
        if (nonCompactCalls === 1) {
          return makeMessage([
            {
              type: 'text',
              text: 'Initial release context recorded.',
            },
          ]);
        }
        if (nonCompactCalls === 2) {
          throw new Error('Provider request failed with HTTP 413: Prompt is too long');
        }
        return makeMessage([
          {
            type: 'text',
            text: 'Recovered after reactive compact.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      compact: {
        preserveRecentMessages: 1,
      },
    });

    try {
      const session = await sdk.createSession();
      await session.send('Remember the release checklist and deployment order.');
      const result = await session.send('Continue with the release notes.');
      const compactState = await session.compactState({
        includeSessionMemory: true,
      });

      expect(result.text).toContain('Recovered after reactive compact.');
      expect(result.reactiveCompact).toMatchObject({
        compacted: true,
        trigger: 'reactive',
      });
      expect(
        modelApi.createCalls.filter(
          request =>
            (request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task ===
            'compact',
        ),
      ).toHaveLength(1);
      expect(compactState.compactCount).toBe(1);
      expect(compactState.summaryMessage).toContain('Reactive compact summary');
      expect(compactState.pendingPostCompaction).toBe(false);
      expect(session.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Reactive compact summary'),
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('runs session hooks that inject context and persist metadata updates', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request) => {
        const hookMessage = request.messages.find(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('Hooked context'),
        );

        return makeMessage([
          {
            type: 'text',
            text: hookMessage ? 'Hooked response.' : 'Missing hook context.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      hooks: {
        sessionStart: [
          () => ({
            messages: [
              {
                role: 'user',
                content:
                  '<system-reminder>Hooked context: prefer release-safe changes.</system-reminder>',
              },
            ],
            systemPromptParts: ['You are running in release-review mode.'],
            metadata: {
              hookInjected: true,
            },
          }),
        ],
        postRun: [
          () => ({
            sessionMetadata: {
              reviewMode: 'release-safe',
            },
            tags: ['hooked'],
          }),
        ],
      },
    });

    try {
      const session = await sdk.createSession();
      const result = await session.send('Review the release steps.');
      const resumed = await sdk.resumeSession(session.id);

      expect(result.text).toContain('Hooked response');
      expect(modelApi.createCalls[0]?.system).toContain('release-review mode');
      expect(modelApi.createCalls[0]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Hooked context'),
          }),
        ]),
      );
      expect(resumed.metadata.reviewMode).toBe('release-safe');
      expect(resumed.tags).toContain('hooked');
      expect(result.sessionHookMetadata).toMatchObject({
        reviewMode: 'release-safe',
      });
    } finally {
      await sdk.close();
    }
  });

  it('runs post-sampling hooks after assistant sampling completes', async () => {
    const sessionDirectory = await createSessionDirectory();
    const seenTexts: string[] = [];
    const modelApi = new MockModelApi({
      create: () =>
        makeMessage([
          {
            type: 'text',
            text: 'Post-sampling hook target response.',
          },
        ]),
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      hooks: {
        postSampling: [
          ({ assistantMessage, iteration, messages }) => {
            seenTexts.push(
              [
                `iteration=${iteration}`,
                extractTextFromContent(assistantMessage.content),
                `messages=${messages.length}`,
              ].join('|'),
            );
          },
        ],
      },
    });

    try {
      const result = await sdk.run('Trigger post-sampling.');

      expect(result.text).toContain('Post-sampling hook target response');
      expect(seenTexts).toHaveLength(1);
      expect(seenTexts[0]).toContain('iteration=1');
      expect(seenTexts[0]).toContain('Post-sampling hook target response.');
    } finally {
      await sdk.close();
    }
  });

  it('supports session-scoped hooks and permission overrides', async () => {
    const sessionDirectory = await createSessionDirectory();
    let executedWrites = 0;
    const modelApi = new MockModelApi({
      create: (request) => {
        const lastMessage = request.messages.at(-1);
        if (typeof lastMessage?.content === 'string') {
          return makeMessage(
            [
              { type: 'text', text: 'Attempting a session-scoped write.' },
              {
                type: 'tool_use',
                id: `toolu_write_${request.messages.length}`,
                name: 'write_note',
                input: { text: 'session-scoped' },
              },
            ],
            'tool_use',
          );
        }

        const toolResults = Array.isArray(lastMessage?.content) ? JSON.stringify(lastMessage.content) : '';
        return makeMessage([
          {
            type: 'text',
            text: toolResults.includes('Denied by permission')
              ? 'Write blocked by the session permission context.'
              : 'Write approved by the session permission context.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      permissionMode: 'plan',
    });

    const writeNote = tool(
      {
        name: 'write_note',
        description: 'Writes a session note.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        executedWrites += 1;
        return { ok: true, text };
      },
    );

    try {
      const session = await sdk.createSession();
      session.setHooks({
        sessionStart: [
          () => ({
            messages: [
              {
                role: 'user',
                content:
                  '<system-reminder>Session runtime hook context: prefer safe release writes.</system-reminder>',
              },
            ],
            systemPromptParts: ['Session runtime system prompt: release-safe writes only.'],
          }),
        ],
        postRun: [
          () => ({
            sessionMetadata: {
              sessionRuntimeHook: 'enabled',
            },
          }),
        ],
      });
      session.setPermissionContext({
        classifier: ({ publicName }) =>
          publicName === 'write_note'
            ? { behavior: 'allow', reason: 'Session runtime classifier approved the write.' }
            : undefined,
      });

      const firstResult = await session.send('First write attempt.', { tools: [writeNote] });
      const firstRequestMessages = modelApi.createCalls[0]?.messages ?? [];

      expect(executedWrites).toBe(1);
      expect(firstResult.permissionDecisions?.[0]).toMatchObject({
        behavior: 'allow',
        source: 'classifier',
      });
      expect(firstResult.sessionHookMetadata).toMatchObject({
        sessionRuntimeHook: 'enabled',
      });
      expect(firstRequestMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Session runtime hook context'),
          }),
        ]),
      );
      expect(modelApi.createCalls[0]?.system).toContain('Session runtime system prompt');

      session.clearHooks();
      session.clearPermissionContext();

      const callCountBeforeSecondRun = modelApi.createCalls.length;
      const secondResult = await session.send('Second write attempt.', { tools: [writeNote] });
      const secondRunRequests = modelApi.createCalls.slice(callCountBeforeSecondRun);

      expect(executedWrites).toBe(1);
      expect(secondResult.toolCalls[0]?.isError).toBe(true);
      expect(secondResult.permissionDecisions?.[0]).toMatchObject({
        behavior: 'deny',
        source: 'mode',
      });
      expect(secondResult.sessionHookMetadata).toBeUndefined();
      expect(secondRunRequests[0]?.system).not.toContain('Session runtime system prompt');
    } finally {
      await sdk.close();
    }
  });

  it('supports clean agent definitions and the Task delegation tool', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request, index) => {
        const isReviewer = request.system?.includes('Review code carefully and focus on risks.');
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Delegating to a reviewer.' },
              {
                type: 'tool_use',
                id: 'toolu_task_1',
                name: 'Task',
                input: {
                  description: 'Review the current change set and summarize the risks.',
                  subagent_type: 'reviewer',
                },
              },
            ],
            'tool_use',
          );
        }

        if (isReviewer) {
          return makeMessage([
            {
              type: 'text',
              text: 'Reviewer summary: watch the release order.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: 'Main agent wrapped the delegated result.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes and call out risks.',
          systemPrompt: 'Review code carefully and focus on risks.',
          metadata: {
            lane: 'review',
          },
        },
      ],
    });

    const taskTool = sdk.createTaskTool();

    try {
      const result = await sdk.run('Please delegate this review.', {
        tools: [taskTool],
      });

      expect(sdk.agents.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            hasSystemPrompt: true,
          }),
        ]),
      );
      expect(modelApi.createCalls).toHaveLength(3);
      expect(result.toolCalls[0]?.publicName).toBe('Task');
      expect(result.toolCalls[0]?.outputText).toContain('Reviewer summary');
      expect(result.text).toContain('wrapped the delegated result');
      expect(result.delegatedAgents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            count: 1,
          }),
        ]),
      );

      const direct = await sdk.runWithAgent('reviewer', 'Review directly.');
      const agentSession = await sdk.createAgentSession('reviewer');
      const sessionResult = await agentSession.send('Review inside a session.');
      const continuity = await agentSession.compactState({ includeSessionMemory: true });
      const directContinuity = await agentSession.agentContinuity();
      expect(direct.text).toContain('Reviewer summary');
      expect(sessionResult.text).toContain('Reviewer summary');
      expect(continuity.agentContinuity).toMatchObject({
        currentAgent: 'reviewer',
      });
      expect(directContinuity).toMatchObject({
        currentAgent: 'reviewer',
      });
    } finally {
      await sdk.close();
    }
  });

  it('applies agent definition hooks in the clean SDK path', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi({
      create: (request) => {
        const hookMessage = request.messages.find(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('Agent hook context'),
        );
        return makeMessage([
          {
            type: 'text',
            text: hookMessage ? 'Agent hook path confirmed.' : 'Agent hooks missing.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes and call out risks.',
          systemPrompt: 'Review code carefully and focus on risks.',
          hooks: {
            sessionStart: [
              () => ({
                messages: [
                  {
                    role: 'user',
                    content:
                      '<system-reminder>Agent hook context: prefer safe release changes.</system-reminder>',
                  },
                ],
                systemPromptParts: ['Agent hook system prompt active.'],
              }),
            ],
            postRun: [
              () => ({
                sessionMetadata: {
                  reviewerMode: 'agent-hooked',
                },
              }),
            ],
          },
        },
      ],
    });

    try {
      const result = await sdk.runWithAgent('reviewer', 'Review this release plan.');

      expect(result.text).toContain('Agent hook path confirmed.');
      expect(result.sessionHookMetadata).toMatchObject({
        reviewerMode: 'agent-hooked',
      });
      expect(modelApi.createCalls[0]?.system).toContain('Agent hook system prompt active.');
      expect(modelApi.createCalls[0]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Agent hook context'),
          }),
        ]),
      );
      expect(sdk.agents.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            hasHooks: true,
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('supports background subagent tasks and task polling', async () => {
    const sessionDirectory = await createSessionDirectory();
    let mainCallCount = 0;
    const modelApi = new MockModelApi({
      create: (request) => {
        const isReviewer = request.system?.includes('Review code carefully and focus on risks.');
        if (isReviewer) {
          return makeMessage([
            {
              type: 'text',
              text: 'Background reviewer summary: verify release ordering before tagging.',
            },
          ]);
        }

        mainCallCount += 1;
        if (mainCallCount === 1) {
          return makeMessage(
            [
              { type: 'text', text: 'Launching a background reviewer.' },
              {
                type: 'tool_use',
                id: 'toolu_task_bg_1',
                name: 'Task',
                input: {
                  description: 'Review the release flow in the background.',
                  subagent_type: 'reviewer',
                  run_in_background: true,
                },
              },
            ],
            'tool_use',
          );
        }

        return makeMessage([
          {
            type: 'text',
            text: 'The reviewer is running in the background.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes and call out risks.',
          systemPrompt: 'Review code carefully and focus on risks.',
        },
      ],
    });

    const taskTool = sdk.createTaskTool();

    try {
      const result = await sdk.run('Start a background review.', {
        tools: [taskTool],
      });
      const taskOutput = result.toolCalls[0]?.output as Record<string, unknown> | undefined;
      const taskId =
        typeof taskOutput?.taskId === 'string' ? taskOutput.taskId : undefined;

      expect(taskOutput?.status).toBe('async_launched');
      expect(taskId).toBeTruthy();
      expect(result.text).toContain('background');

      const completedTask = await sdk.tasks.wait(taskId!);
      const listedTasks = await sdk.tasks.list();

      expect(completedTask.status).toBe('completed');
      expect(completedTask.text).toContain('Background reviewer summary');
      expect(completedTask.outputFile).toContain(taskId!);
      expect(listedTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: taskId,
            status: 'completed',
            subagentType: 'reviewer',
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('marks pending post-compaction state after extraction and clears it on the next normal run', async () => {
    const tempDir = await createSessionDirectory();
    const homeDir = path.join(tempDir, 'home');
    const workDir = path.join(tempDir, 'workspace');
    const longPrompt = 'release-checklist '.repeat(4000);
    const modelApi = new MockModelApi({
      create: (request, index) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'session_memory') {
          return makeMessage([
            {
              type: 'text',
              text: [
                '# Session Title',
                '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
                '',
                'Release memory snapshot',
                '',
                '# Current State',
                '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
                '',
                'Preparing the next public release and checking version/tag order.',
              ].join('\n'),
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: index > 1 ? 'Small follow-up.' : 'Working through the release checklist.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: path.join(tempDir, 'sessions'),
      homeDir,
      workDir,
      modelApi,
    });

    try {
      const session = await sdk.createSession();
      await session.send(longPrompt);
      const afterExtraction = await session.compactState({
        includeSessionMemory: true,
      });

      await session.send('Quick follow-up.');
      const afterFollowUp = await session.compactState({
        includeSessionMemory: true,
      });

      expect(afterExtraction.pendingPostCompaction).toBe(true);
      expect(afterExtraction.runtimeState?.pendingPostCompaction).toBe(true);
      expect(afterFollowUp.pendingPostCompaction).toBe(false);
      expect(afterFollowUp.runtimeState?.pendingPostCompaction).toBe(false);
    } finally {
      await sdk.close();
    }
  });
});

